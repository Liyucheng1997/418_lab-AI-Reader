"""AI Reader 的 F5-TTS 朗读服务（由 Electron 主进程启动，只监听 127.0.0.1）。

与“静听”听书软件使用同一个模型（F5TTS_v1_Base）和同样的推理参数：
  GET  /status   模型加载状态
  GET  /voices   可用音色（静听里添加的音色 + F5 自带示例）
  POST /synth    {text, ref_audio, ref_text} -> WAV，结果按内容缓存到磁盘
父进程（Electron）退出后本服务随之退出。
"""
import os

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

import argparse
import glob
import hashlib
import io
import json
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import soundfile as sf

from tts_text import make_pinyin_converter, normalize_text

ARGS = None
_model = None
_model_lock = threading.Lock()
_infer_lock = threading.Lock()
_status = {"loaded": False, "loading": False, "device": "", "error": None}


def _patch_torchaudio():
    """torchaudio 新版默认走 torchcodec（需要 FFmpeg），改用 libsndfile 读音频。"""
    try:
        import torch
        import torchaudio

        def _load(path, *args, **kwargs):
            data, sr = sf.read(str(path), dtype="float32", always_2d=True)
            return torch.from_numpy(data.T.copy()), sr

        def _info(path, *args, **kwargs):
            info = sf.info(str(path))
            return type("AudioInfo", (), {
                "sample_rate": info.samplerate, "num_frames": info.frames, "num_channels": info.channels,
            })()

        torchaudio.load = _load
        torchaudio.info = _info
    except Exception:
        pass


def _patch_transcribe():
    """参考文本留空时 F5 会用 Whisper 识别，原实现按文件名读音频需要 FFmpeg，这里直接喂采样数据。"""
    try:
        from f5_tts.infer import utils_infer

        def _transcribe(ref_audio, language=None):
            if utils_infer.asr_pipe is None:
                utils_infer.initialize_asr_pipeline(device=utils_infer.device)
            data, sr = _read_mono(ref_audio)
            kw = {"task": "transcribe", "language": language} if language else {"task": "transcribe"}
            result = utils_infer.asr_pipe({"raw": data, "sampling_rate": sr}, chunk_length_s=30,
                                          batch_size=128, generate_kwargs=kw, return_timestamps=False)
            return result["text"].strip()

        utils_infer.transcribe = _transcribe
    except Exception:
        pass


def _patch_pinyin(model):
    """F5 把词表里没有的拼音当成空白：轻声的“这个 ge”“意思 si”“差不多 bu”整字被吞，换成能读出来的。"""
    try:
        from f5_tts.infer import utils_infer
        utils_infer.convert_char_to_pinyin = make_pinyin_converter(set(model.ema_model.vocab_char_map))
    except Exception:
        pass


def _get_model():
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        _status["loading"] = True
        try:
            import torch
            _patch_torchaudio()
            from f5_tts.api import F5TTS
            _patch_transcribe()
            device = "cuda" if torch.cuda.is_available() else "cpu"
            _status["device"] = torch.cuda.get_device_name(0) if device == "cuda" else "CPU"
            _model = F5TTS(model="F5TTS_v1_Base", device=device)
            _patch_pinyin(_model)
            _status["loaded"] = True
            _status["error"] = None
        except Exception as e:
            _status["error"] = str(e)
            raise
        finally:
            _status["loading"] = False
    return _model


def _read_mono(path):
    data, sr = sf.read(path, dtype="float32", always_2d=False)
    if getattr(data, "ndim", 1) > 1:
        data = data.mean(axis=1)
    return data, sr


def _prepare_ref(path):
    """F5 读参考音频时 flac/mp3 需要 FFmpeg，统一转成 WAV 缓存起来。"""
    if path.lower().endswith(".wav"):
        return path
    st = os.stat(path)
    key = hashlib.sha1(f"{path}|{st.st_size}|{st.st_mtime}".encode("utf-8")).hexdigest()[:16]
    dest = os.path.join(ARGS.cache, "refs", key + ".wav")
    if not os.path.exists(dest):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        data, sr = _read_mono(path)
        sf.write(dest, data, sr, subtype="PCM_16")
    return dest


def list_voices():
    voices = []
    if ARGS.jingting:  # 静听里添加的音色（含克隆的人声）
        db = os.path.join(ARGS.jingting, "data", "library.db")
        if os.path.exists(db):
            try:
                conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
                rows = conn.execute("SELECT name, ref_audio, ref_text FROM voices ORDER BY builtin, id").fetchall()
                conn.close()
                voices += [{"name": n, "refAudio": a, "refText": t or "", "source": "静听"}
                           for n, a, t in rows if a and os.path.exists(a)]
            except Exception:
                pass
    try:  # F5 自带的中文示例
        import importlib.util
        spec = importlib.util.find_spec("f5_tts")
        base = list(spec.submodule_search_locations)[0]
        for wav in glob.glob(os.path.join(base, "infer", "examples", "basic", "*_zh.wav")):
            voices.append({"name": "F5 示例（中文）", "refAudio": wav,
                           "refText": "对，这就是我，万人敬仰的太乙真人。", "source": "F5"})
    except Exception:
        pass
    return voices


class Cancelled(Exception):
    pass


_epoch = 0  # 朗读位置变了（跳转 / 停止）客户端会换新的 epoch，排队中的旧请求直接放弃


def synth(text, ref_audio, ref_text, epoch=0):
    global _epoch
    _epoch = max(_epoch, epoch)
    text = normalize_text(text)  # 数字、轻声、兼容区汉字等 F5 读不出或读错的，先改写
    if not ref_audio:
        voices = list_voices()
        if not voices:
            raise RuntimeError("没有可用的参考音色")
        ref_audio, ref_text = voices[0]["refAudio"], voices[0]["refText"]
    if not os.path.exists(ref_audio):
        raise RuntimeError(f"参考音频不存在：{ref_audio}")
    key = hashlib.sha1(f"{ref_audio}|{ref_text}|{text}".encode("utf-8")).hexdigest()
    out = os.path.join(ARGS.cache, key + ".wav")
    if os.path.exists(out):
        return out
    model = _get_model()
    ref = _prepare_ref(ref_audio)
    with _infer_lock:  # 单个 GPU 模型，串行推理
        if os.path.exists(out):  # 排队期间别的请求已经合成了同一段（预取）
            return out
        if epoch < _epoch:
            raise Cancelled()
        wav, sr, _ = model.infer(
            ref_file=ref, ref_text=ref_text or "", gen_text=text, speed=1.0,
            nfe_step=32, cross_fade_duration=0.15, remove_silence=False,
            file_wave=None, show_info=lambda *a, **k: None,
        )
    wav = np.asarray(wav, dtype=np.float32)
    peak = float(np.max(np.abs(wav))) if wav.size else 0.0
    if peak > 0:  # 各段音量一致
        wav = wav * (0.95 / peak)
    tmp = out + ".tmp"
    sf.write(tmp, wav, sr, format="WAV")
    os.replace(tmp, out)
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/status":
            self._send(200, json.dumps(_status, ensure_ascii=False))
        elif self.path == "/voices":
            self._send(200, json.dumps(list_voices(), ensure_ascii=False))
        else:
            self._send(404, "not found", "text/plain; charset=utf-8")

    def do_POST(self):
        if self.path != "/synth":
            return self._send(404, "not found", "text/plain; charset=utf-8")
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            text = (body.get("text") or "").strip()
            if not text:
                return self._send(400, "空文本", "text/plain; charset=utf-8")
            path = synth(text, body.get("ref_audio") or "", body.get("ref_text") or "", int(body.get("epoch") or 0))
            with open(path, "rb") as f:
                self._send(200, f.read(), "audio/wav")
        except Cancelled:
            self._send(409, "已取消", "text/plain; charset=utf-8")
        except Exception as e:
            self._send(500, f"语音合成失败：{e}", "text/plain; charset=utf-8")


def _exit_with_parent(pid):
    # 不能靠阻塞读 stdin 判断：Windows 上管道的同步读会卡住其他线程加载 DLL（scipy/BLAS）
    if not pid:
        return
    if os.name == "nt":
        import ctypes
        handle = ctypes.windll.kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if handle:
            ctypes.windll.kernel32.WaitForSingleObject(handle, 0xFFFFFFFF)
    else:
        import time
        while os.getppid() == pid:
            time.sleep(2)
    os._exit(0)


def main():
    global ARGS
    p = argparse.ArgumentParser()
    p.add_argument("--cache", required=True)
    p.add_argument("--jingting", default="")
    p.add_argument("--port", type=int, default=0)
    p.add_argument("--parent-pid", type=int, default=0)
    ARGS = p.parse_args()
    os.makedirs(ARGS.cache, exist_ok=True)
    threading.Thread(target=_exit_with_parent, args=(ARGS.parent_pid,), daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    print(f"F5_READY {server.server_address[1]}", flush=True)
    threading.Thread(target=_warmup, daemon=True).start()  # 后台预加载模型，首段更快
    server.serve_forever()


def _warmup():
    try:
        model = _get_model()
        voices = list_voices()
        if voices:  # 先空跑一次，让 CUDA 内核编译好，第一段朗读不用等十几秒
            with _infer_lock:
                model.infer(ref_file=_prepare_ref(voices[0]["refAudio"]), ref_text=voices[0]["refText"],
                            gen_text="你好。", nfe_step=8, file_wave=None, show_info=lambda *a, **k: None)
    except Exception:
        pass


if __name__ == "__main__":
    main()
