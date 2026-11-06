"""F5-TTS 合成前的文字处理：让模型把每个字都读出来、读对。

F5 先把汉字转成拼音，再按词表（vocab.txt）查编号，词表里没有的一律当成空白，那个字就被吞掉了：
  - 阿拉伯数字原样交给模型，会按英文读 → normalize_numbers 改写成中文读法
    （1998年 → 一九九八年，35个 → 三十五个，3.14 → 三点一四，20% → 百分之二十，8:30 → 八点三十分，2个 → 两个）
  - 轻声拼音（这个 ge、意思 si、差不多 bu、功夫 fu、折腾 teng）词表里没有 → make_pinyin_converter 换成本调
  - 兼容区汉字（PDF 里常见的“不”U+F967）、康熙部首“⼀”、全角冒号括号等 → clean_text 换成词表里有的写法
"""
import re
import unicodedata

DIGITS = "零一二三四五六七八九"
_CJK = re.compile(r"[\u3400-\u9fff]")
_LATIN = re.compile(r"[A-Za-z]")
_FULLWIDTH = str.maketrans("０１２３４５６７８９％", "0123456789%")

# 数值为 2 时后面跟这些量词读“两”（两个、两年、两点）
_LIANG_NEXT = set("个位人次天年岁本只件种条张份名倍点辆家座台把双对句步页杯碗瓶块元毛角斤克米里间颗粒棵匹头场声下回遍段公千万亿周样口趟顿封枚门首")
_UNITS = {
    "km²": "平方公里", "m²": "平方米", "㎡": "平方米", "km": "公里", "kg": "公斤",
    "cm": "厘米", "mm": "毫米", "ml": "毫升", "mL": "毫升", "℃": "摄氏度", "°C": "摄氏度", "°F": "华氏度",
}


def _zh_context(text, start, end):
    """附近有汉字，或者附近没有英文字母（比如单独一个数字），就按中文读。"""
    win = text[max(0, start - 12):end + 12]
    return bool(_CJK.search(win)) or not _LATIN.search(win)


def _section(n):
    """0 < n < 10000"""
    out, zero = "", False
    for val, unit in ((1000, "千"), (100, "百"), (10, "十"), (1, "")):
        d = n // val % 10
        if d == 0:
            zero = bool(out)
        else:
            if zero:
                out += "零"
                zero = False
            out += DIGITS[d] + unit
    return out


def int_to_zh(n):
    """整数的中文读法：10 → 十，105 → 一百零五，20000 → 两万。"""
    if n == 0:
        return "零"
    secs = []
    while n:
        secs.append(n % 10000)
        n //= 10000
    out, gap = "", False
    for i in range(len(secs) - 1, -1, -1):
        sec = secs[i]
        if sec == 0:
            gap = bool(out)
            continue
        if out and (gap or sec < 1000):
            out += "零"
        gap = False
        out += _section(sec) + ("", "万", "亿")[i]
    if out.startswith("一十"):
        out = out[1:]
    return re.sub(r"(?<![十百千])二(?=[千万亿])", "两", out)


def digits_to_zh(s):
    return "".join(DIGITS[int(c)] for c in s)


def number_to_zh(s):
    """数字串（可带小数）按数值读；太长或以 0 开头的按位读。"""
    if "." in s:
        a, b = s.split(".", 1)
        return number_to_zh(a) + "点" + digits_to_zh(b)
    if len(s) > 1 and s[0] == "0" or len(s) > 12:
        return digits_to_zh(s)
    return int_to_zh(int(s))


def _sub(pattern, repl, text):
    """只替换处在中文语境里的匹配。"""
    def f(m):
        if not _zh_context(m.string, m.start(), m.end()):
            return m.group(0)
        r = repl(m)
        return m.group(0) if r is None else r
    return re.sub(pattern, f, text)


def _date(m):
    y, mo, d = m.group(1), int(m.group(3)), int(m.group(4))  # 第 2 组是分隔符
    if not (1 <= mo <= 12 and 1 <= d <= 31):
        return None
    return f"{digits_to_zh(y)}年{int_to_zh(mo)}月{int_to_zh(d)}日"


def _year(m):
    y = m.group(1)
    # 1998年 → 一九九八年；3000年、2000年 → 三千年、两千年；15年 → 十五年
    if len(y) == 4 and y[0] in "12" and not y.endswith("000"):
        return digits_to_zh(y)
    return number_to_zh(y)


def _clock(m):
    h, mi, sec = int(m.group(1)), m.group(2), m.group(3)
    out = ("两" if h == 2 else int_to_zh(h)) + "点"
    if mi != "00" or sec:
        out += ("零" if mi[0] == "0" and mi != "00" else "") + int_to_zh(int(mi)) + "分"
    if sec:
        out += ("零" if sec[0] == "0" and sec != "00" else "") + int_to_zh(int(sec)) + "秒"
    return out


def _integer(m):
    s, text = m.group(0), m.string
    before = text[m.start() - 1] if m.start() else ""
    after = text[m.end()] if m.end() < len(text) else ""
    if re.fullmatch(r"1[3-9]\d{9}", s) or re.search(r"\d-$", text[:m.start()]):  # 手机号、010-12345678 这类编号
        return digits_to_zh(s)
    if len(s) >= 3 and (_LATIN.match(before or " ") or _LATIN.match(after or " ")):  # A380、RTX4090
        return digits_to_zh(s)
    if s == "2" and after in _LIANG_NEXT and before != "第" and not text.startswith("年级", m.end()):
        return "两"
    return number_to_zh(s)


def normalize_numbers(text):
    if not re.search(r"[0-9０-９]", text):
        return text
    text = text.translate(_FULLWIDTH)
    # 千分位：1,234,567 → 1234567
    text = _sub(r"(?<![\d.,])\d{1,3}(?:,\d{3})+(?![\d,])", lambda m: m.group(0).replace(",", ""), text)
    # 单位：5km → 5公里，25℃ → 25摄氏度
    text = _sub(r"(?<=\d)\s*(km²|m²|㎡|km|kg|cm|mm|mL|ml|℃|°C|°F)(?![A-Za-z])", lambda m: _UNITS[m.group(1)], text)
    # 日期：2024-05-06 → 二零二四年五月六日
    text = _sub(r"(?<![\d.])([12]\d{3})([-/.])(\d{1,2})\2(\d{1,2})(?![\d.]?\d)", _date, text)
    # 年份：1998年；括号里注的年份（1924）、（1924—1990）
    text = _sub(r"(?<![\d.])(\d{1,4})(?=年(?!级))", _year, text)
    text = _sub(r"[（(]\s*([12]\d{3})\s*(?:[-—–~～]+\s*([12]\d{3})\s*)?[）)]",
                lambda m: "（" + digits_to_zh(m.group(1)) + ("到" + digits_to_zh(m.group(2)) if m.group(2) else "") + "）", text)
    # 时刻：8:30 → 八点三十分；其余的 3:2 → 三比二
    text = _sub(r"(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(?![\d:])", _clock, text)
    text = _sub(r"(?<![\d.])(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)(?![\d.])",
                lambda m: number_to_zh(m.group(1)) + "比" + number_to_zh(m.group(2)), text)
    # 百分数、千分数
    text = _sub(r"(?<![\d.])([-−]?)(\d+(?:\.\d+)?)\s*([%‰])",
                lambda m: ("负" if m.group(1) else "") + ("百分之" if m.group(3) == "%" else "千分之") + number_to_zh(m.group(2)), text)
    # 分数：3/4 → 四分之三
    text = _sub(r"(?<![\d./])(\d+)/(\d+)(?![\d/])", lambda m: number_to_zh(m.group(2)) + "分之" + number_to_zh(m.group(1)), text)
    # 范围：3-5个 → 3到5个（电话号码 010-12345678 不算）
    text = _sub(r"(?<![\d.])([1-9]\d{0,3}(?:\.\d+)?)\s*[-~～—–]+\s*(?=\d{1,4}(?:\.\d+)?(?![\d.]))",
                lambda m: m.group(1) + "到", text)
    # 负数：-5 → 负5
    text = _sub(r"(?<![A-Za-z0-9.])[-−](?=\d)", lambda m: "负", text)
    # 版本号之类多个点的：1.2.3 → 一点二点三
    text = _sub(r"(?<![\d.])\d+(?:\.\d+){2,}(?![\d.]?\d)", lambda m: "点".join(number_to_zh(p) for p in m.group(0).split(".")), text)
    # 小数、整数
    text = _sub(r"(?<![\d.])\d+\.\d+(?![\d.]?\d)", lambda m: number_to_zh(m.group(0)), text)
    text = _sub(r"\d+", _integer, text)
    return text


# ---------------- 字符清理 ----------------

_PRE = str.maketrans({
    "\u3000": " ", "\ufeff": "", "\u200b": "", "－": "-", "～": "~", "．": ".", "﹣": "-", "㎡": "平方米",
    **{c: "" for c in "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽❶❷❸❹❺❻❼❽❾❿"},  # 注释编号
    **{c: " " for c in "◎○●◇◆□■△▲▽▼☆★※◆◇▪▫•"},  # 项目符号、缺字方框
    **{c: n for cs in ("ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ", "ⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹⅺⅻ")
       for c, n in zip(cs, "一 二 三 四 五 六 七 八 九 十 十一 十二".split())},  # 罗马数字
})
# 词表里没有的标点：换成读起来停顿相近、词表里有的
_POST = str.maketrans({
    "：": "，", "；": "，", "﹔": "，", "﹕": "，", "|": "，", "｜": "，",
    "（": "，", "）": "，", "［": "，", "］": "，", "〔": "，", "〕": "，",
    "﹑": "、",
})
# 引号、书名号不发音，但 F5 按字节数估算时长，“ ” 各占 3 字节（和一个汉字一样），多出的时长就成了停顿
_SILENT_MARKS = re.compile(r"[“”‘’\"「」『』《》〈〉﹁﹂﹃﹄]")


def _compat(m):
    return unicodedata.normalize("NFKC", m.group(0))


def clean_text(text):
    """兼容区汉字、康熙部首、全角字母 → 标准写法；去掉注释编号、私用区字符（显示成方框的生僻字）。"""
    text = text.translate(_PRE)
    text = re.sub(r"[\uf900-\ufaff\U0002f800-\U0002fa1f\u2f00-\u2fdf\u2e80-\u2eff\uff21-\uff3a\uff41-\uff5a]", _compat, text)
    return re.sub(r"[\ue000-\uf8ff]", "", text)


def normalize_text(text):
    text = normalize_numbers(clean_text(text))
    text = text.translate(_POST)
    text = re.sub(r"(?<=[A-Za-z])[’‘](?=[A-Za-z])", "'", text)  # 英文的 it’s 保留成撇号
    text = _SILENT_MARKS.sub("", text)
    text = re.sub(r"\s*，[\s，]*", "，", text)  # 括号、冒号换成逗号后连在一起的
    text = re.sub(r"，(?=[。！？!?…、，,.])", "", text)
    return re.sub(r"^\s*，", "", text).strip() or text.strip()


# ---------------- 拼音 ----------------

# “地”前面是这些字时是名词 dì：这里的地、一块地、种地、土地、各地。
# 容易和“X地 + 动词”混淆的字（心、实、极、分、福、异、平、着……：小心地、踏实地、积极地、充分地）不放进来
_DI_PREV = set("的块片亩这那此该各本当外内满遍落倒跪坐躺扫耕种犁拖买卖占圈下田土草天大陆山盆基营墓境余园阵领腹圣胜产属封驻宝绝死席拔触原就两场林湿个等")
# 前两个字是这些词时“地”是助词：适当地、意外地
_DE_AFTER = {"适当", "恰当", "妥当", "相当", "稳当", "正当", "得当", "理当", "意外", "格外", "另外", "额外", "分外", "例外"}
# 这两个词前面再多一个字就成了形容词：特地 / 独特地，极地 / 积极地
_DI_PAIRS = {"特地": "独奇", "极地": "积消终太"}
# 以“地”开头、后面又不太会接成动词的名词：……的地球、往地图上
_DI_NOUNS = ("地球", "地方", "地图", "地位", "地址", "地狱", "地域", "地板", "地毯", "地段", "地盘", "地铁", "地租",
             "地价", "地皮", "地壳", "地窖", "地洞", "地层", "地雷", "地瓜", "地府", "地藏", "地名", "地标", "地貌",
             "地缘", "地平线", "地心", "地质", "地基", "地势", "地契", "地下室", "地主", "地区")
# 名词后面接这些时其实是“地 + 动词”：积极地主动、清楚地区分
_DI_NOUN_NOT = ("地主动", "地主张", "地主持", "地主导", "地区分", "地区别")
# 在地上、从地下、往地里：介词、动作后面跟方位
_DI_LOC_PREV = set("在从往向到于趴扑摔掉进入")


def make_di_reader():
    """“地”的读音：结构助词（慢慢地走、一条条地列出来、认真地学习）读 de，名词（土地、地上、种地）读 dì。
    pypinyin 不管语境一律给 di4，这里看前后文判断。"""
    from pypinyin.constants import PHRASES_DICT

    # 三字以上、“地”不在开头的词：惊天动地、暗地里、目的地、死心塌地
    long_words = {w: [k for k, c in enumerate(w) if c == "地" and k > 0 and PHRASES_DICT[w][k][0] == "dì"]
                  for w in PHRASES_DICT if "地" in w[1:] and 3 <= len(w) <= 5}

    def in_long_word(text, i):
        for a in range(max(0, i - 4), i):
            for b in range(i + 1, min(len(text), a + 5) + 1):
                if i - a in long_words.get(text[a:b], ()):
                    return True
        return False

    def reading(text, i):
        prev = text[i - 1] if i else ""
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if i >= 2 and prev == text[i - 2] and _CJK.match(prev):
            return "de"  # 慢慢地、一条条地、一步步地
        if in_long_word(text, i):
            return "di4"
        if not _CJK.match(prev):
            return "di4"  # 句首：地很肥
        if text[max(0, i - 2):i] in _DE_AFTER:
            return "de"
        pair = _DI_PAIRS.get(text[i - 1:i + 1])
        if pair and not (i >= 2 and text[i - 2] in pair):
            return "di4"
        if nxt in "而之也者矣乎焉兮" or not _CJK.match(nxt or "。"):
            return "di4"  # 助词“地”后面总跟着动作：画地而趋、三分其地，、有天哪有地
        if prev in _DI_PREV:
            return "di4"
        if any(text.startswith(w, i) for w in _DI_NOUNS) and not any(text.startswith(w, i) for w in _DI_NOUN_NOT):
            return "di4"
        if prev in _DI_LOC_PREV and nxt and nxt in "上下里面底中":
            return "di4"
        return "de"  # 认真地学习、激动地说

    return reading


def make_pinyin_converter(vocab):
    """和 f5_tts.model.utils.convert_char_to_pinyin 一样，但词表里没有的拼音换成相近的读音，不再吞字。"""
    import rjieba
    from pypinyin import Style, lazy_pinyin, pinyin

    trans = str.maketrans({";": ",", "“": '"', "”": '"', "‘": "'", "’": "'"})
    fixed = {}

    def fix_vocab(py, ch):
        if py in vocab:
            return py
        key = (py, ch)
        if key not in fixed:
            base = py.rstrip("012345")
            cands = [pinyin(ch, style=Style.TONE3)[0][0]] + [base + t for t in "41235"]  # 先用这个字的本调
            fixed[key] = next((c for c in cands if c in vocab), py)
        return fixed[key]

    def is_chinese(c):
        return "\u3100" <= c <= "\u9fff"

    di = make_di_reader()

    def convert(text_list, polyphone=True):
        final = []
        for text in text_list:
            chars = []
            text = text.translate(trans)  # 逐字替换，不改变长度，pos 和 text 对得上
            pos = 0
            for seg in rjieba.cut(text):
                start, pos = pos, pos + len(seg)

                def fix(py, c, k):
                    return fix_vocab(di(text, start + k) if c == "地" else py, c)

                n = len(seg.encode("utf-8"))
                if n == len(seg):  # 纯字母和符号
                    if chars and n > 1 and chars[-1] not in " :'\"":
                        chars.append(" ")
                    chars.extend(seg)
                elif polyphone and n == 3 * len(seg):  # 纯汉字
                    py = lazy_pinyin(seg, style=Style.TONE3, tone_sandhi=True)
                    for i, c in enumerate(seg):
                        if is_chinese(c):
                            chars.append(" ")
                            chars.append(fix(py[i], c, i))
                        else:
                            chars.append(py[i])
                else:  # 混合
                    for k, c in enumerate(seg):
                        if ord(c) < 256:
                            chars.append(c)
                        elif is_chinese(c):
                            chars.append(" ")
                            chars.append(fix(lazy_pinyin(c, style=Style.TONE3, tone_sandhi=True)[0], c, k))
                        else:
                            chars.append(c)
            final.append(chars)
        return final

    return convert
