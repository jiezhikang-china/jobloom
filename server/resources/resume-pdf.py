"""Edit the existing PDF's text areas, retaining all other page objects and geometry."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "vendor" / "pdf-runtime"))
try:
    import pymupdf as fitz
except ImportError:
    raise SystemExit("PDF 组件未安装，请运行 npm run setup:pdf 后重试")

def fail(message):
    raise ValueError(message)

def clean(text):
    return re.sub(r"[\u200b-\u200d\ufeff]", "", text).strip()

def joined_text(a, b):
    # CJK wraps without spaces; Latin words need a gap unless a word was split by the PDF.
    return a + (" " if a[-1:].isascii() and b[:1].isascii() and a[-1:].isalnum() and b[:1].isalnum() else "") + b

def layout(doc):
    pages, regions = [], []
    for page_num, page in enumerate(doc):
        rows = []
        for block in page.get_text("dict", sort=True)["blocks"]:
            for line in block.get("lines", []):
                spans = [s for s in line["spans"] if clean(s["text"])]
                if not spans:
                    continue
                if tuple(line.get("dir", (1, 0))) != (1, 0):
                    continue
                rect = fitz.Rect(spans[0]["bbox"])
                for span in spans[1:]:
                    rect |= fitz.Rect(span["bbox"])
                largest = max(spans, key=lambda s: len(clean(s["text"])))
                rows.append({"text": clean("".join(s["text"] for s in spans)), "bbox": list(rect),
                    "size": largest["size"], "font": largest["font"], "color": largest["color"],
                    "flags": largest["flags"], "baseline": spans[0]["origin"][1]})
        rows.sort(key=lambda r: (round(r["baseline"], 1), r["bbox"][0]))
        merged = []
        for row in rows:
            prev = merged[-1] if merged else None
            if prev and abs(prev["baseline"] - row["baseline"]) < 1 and -0.5 <= row["bbox"][0] - prev["bbox"][2] <= row["size"] * 0.3:
                prev["text"] += row["text"]
                prev["bbox"] = list(fitz.Rect(prev["bbox"]) | fitz.Rect(row["bbox"]))
                prev["size"] = max(prev["size"], row["size"])
            else:
                merged.append(row.copy())
        groups = []
        for row in merged:
            prev = groups[-1] if groups else None
            if (prev and len(prev["text"]) >= 20 and not re.search(r"[。！？!?：:]$", prev["text"])
                and not row["text"].startswith(("•", "●", "·", "-"))
                and abs(prev["bbox"][0] - row["bbox"][0]) < 2
                and abs(prev["size"] - row["size"]) < 0.6
                and prev["color"] == row["color"] and prev["flags"] == row["flags"]
                and 0 < row["baseline"] - prev["lastBaseline"] < row["size"] * 2.2):
                prev["text"] = joined_text(prev["text"], row["text"])
                prev["bbox"] = list(fitz.Rect(prev["bbox"]) | fitz.Rect(row["bbox"]))
                prev["lastBaseline"] = row["baseline"]
                prev["lines"].append(row)
            else:
                groups.append({**row, "lastBaseline": row["baseline"], "lines": [row]})
        for index, group in enumerate(groups):
            value = group["text"]
            protected = (len(value) < 24 or group["size"] > 12.1 or bool(group["flags"] & 16)
                or group["bbox"][1] < min(140, page.rect.height * 0.18)
                or (not value.startswith(("•", "●", "·", "-")) and bool(re.search(r"有限公司|大学|学院|学校|^(?:姓名|住址|地址|联系)", value)))
                or bool(re.search(r"\b1[3-9]\d{9}\b|[\w.+-]+@[\w.-]+|期望(?:薪资|城市)|年龄|\d+年工作经验", value))
                or bool(re.search(r"20\d{2}[./年-].{0,14}20\d{2}", value)))
            region = {**group, "id": f"p{page_num + 1}-r{index}", "page": page_num + 1,
                "editable": not protected, "maxChars": len(value)}
            regions.append(region)
        pages.append({"width": page.rect.width, "height": page.rect.height, "rotation": page.rotation})
    return {"pageCount": len(doc), "pages": pages, "regions": regions}

def number_tokens(text):
    return sorted(re.findall(r"\d+(?:\.\d+)?(?:%|％)?", text))

def pick_font(doc, page, region, text):
    for record in page.get_fonts(full=True):
        name = record[3].split("+")[-1]
        if name != region["font"]:
            continue
        try:
            data = doc.extract_font(record[0])[3]
            font = fitz.Font(fontbuffer=data) if data else None
            if font and all(c.isspace() or font.has_glyph(ord(c)) for c in text):
                return font, data
        except Exception:
            continue
    font = fitz.Font("cjk")
    if not all(c.isspace() or font.has_glyph(ord(c)) for c in text):
        fail("优化文字包含无法显示的字符，请调整后重试")
    return font, font.buffer

def wrap(text, width, font, size):
    # Keep Latin technology names intact wherever possible.
    tokens = re.findall(r"[A-Za-z0-9_+#.%/-]+|[^A-Za-z0-9_+#.%/-]", text)
    lines, current = [], ""
    for token in tokens:
        if token == "\n":
            if current.strip(): lines.append(current.rstrip())
            current = ""
            continue
        if current and font.text_length(current + token, fontsize=size) > width + 0.01:
            lines.append(current.rstrip())
            current = token.lstrip()
        else:
            current += token
        if font.text_length(current, fontsize=size) > width + 0.01:
            fail("优化文字中有过长单词，无法放入原 PDF 的文字区域")
    if current.strip(): lines.append(current.rstrip())
    return lines

def paragraph_width(page, region, info):
    # The original glyph bounds can end far before the paragraph's column edge.
    # Reuse empty space within that column, keeping the font, anchor and line count.
    rect = fitz.Rect(region["bbox"])
    peers = [line for item in info["regions"] if item["page"] == region["page"]
        for line in item["lines"] if abs(line["bbox"][0] - rect.x0) < 3
        and abs(line["size"] - region["size"]) < 0.8]
    right = min(page.rect.x1 - 12, max([rect.x1] + [line["bbox"][2] for line in peers]))
    obstacles = [fitz.Rect(line["bbox"]) for item in info["regions"]
        if item["page"] == region["page"] and item["id"] != region["id"] for line in item["lines"]]
    obstacles += [fitz.Rect(image["bbox"]) for image in page.get_image_info()]
    for obstacle in obstacles:
        if obstacle.x0 >= rect.x1 - 0.5 and obstacle.y0 < rect.y1 and obstacle.y1 > rect.y0:
            right = min(right, obstacle.x0 - 3)
    return max(rect.width, right - rect.x0) + 0.4

def fit_paragraph(text, width, font, size, line_count):
    lines = wrap(text, width, font, size)
    # Lossless phrasing reductions only. Never truncate a sentence or shrink its font.
    for verbose, concise in [("完成代码编写与调试", "编写、调试代码"),
        ("进行二次剪辑与标题优化", "二次剪辑、优化标题")]:
        if len(lines) <= line_count:
            break
        candidate = text.replace(verbose, concise)
        if number_tokens(candidate) == number_tokens(text):
            text = candidate
            lines = wrap(text, width, font, size)
    return text, lines

def apply_edits(doc, info, edits):
    if not isinstance(edits, list) or not edits or len(edits) > 80:
        fail("未收到有效的简历优化内容")
    by_id = {r["id"]: r for r in info["regions"]}
    prepared, seen = [], set()
    for edit in edits:
        region = by_id.get(edit.get("id"))
        if not region or not region["editable"] or region["id"] in seen:
            fail("优化内容引用了不存在、受保护或重复的文字区域")
        seen.add(region["id"])
        text = clean(edit.get("text", ""))
        if not text or len(text) > region["maxChars"] or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]", text):
            fail("优化文字超出原区域长度或包含无效字符，请重试")
        if number_tokens(region["text"]) != number_tokens(text):
            fail("优化内容改变了原简历中的数字，已阻止输出")
        if text == region["text"]: continue
        page = doc[region["page"] - 1]
        rect = fitz.Rect(region["bbox"])
        # Keep original line positions; only unused space in the same text column is available.
        font, buffer = pick_font(doc, page, region, text)
        size = region["size"]
        text, lines = fit_paragraph(text, paragraph_width(page, region, info), font, size, len(region["lines"]))
        if len(lines) > len(region["lines"]):
            fail(f"第 {region['page']} 页段落 {region['id']} 的优化文字超出原排版空间，请缩短这一段后重试")
        prepared.append({"region": region, "text": text, "font": font, "buffer": buffer, "size": size, "lines": lines})
    if not prepared: fail("优化结果未修改任何简历内容，请调整目标岗位后重试")
    for page_index in range(len(doc)):
        page = doc[page_index]
        on_page = [p for p in prepared if p["region"]["page"] == page_index + 1]
        for item in on_page:
            for line in item["region"]["lines"]:
                # Do not paint a white rectangle: the existing background and vector decorations survive.
                page.add_redact_annot(fitz.Rect(line["bbox"]), fill=False, cross_out=False)
        if on_page: page.apply_redactions(images=0, graphics=0, text=0)
        inserted_fonts = {}
        for item in on_page:
            region = item["region"]
            font_key = hashlib.sha256(item["buffer"]).hexdigest()
            name = inserted_fonts.get(font_key)
            if not name:
                name = "ResumeEdit" + str(len(inserted_fonts))
                page.insert_font(fontname=name, fontbuffer=item["buffer"])
                inserted_fonts[font_key] = name
            rgb = tuple(((region["color"] >> shift) & 255) / 255 for shift in (16, 8, 0))
            for line_index, value in enumerate(item["lines"]):
                original_line = region["lines"][line_index]
                page.insert_text((original_line["bbox"][0], original_line["baseline"]), value,
                    fontname=name, fontsize=item["size"], color=rgb, overlay=True)
    return [{"id": p["region"]["id"], "page": p["region"]["page"], "before": p["region"]["text"], "after": p["text"]} for p in prepared]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["inspect", "edit"])
    parser.add_argument("--input", required=True)
    parser.add_argument("--edits")
    parser.add_argument("--output")
    args = parser.parse_args()
    with fitz.open(args.input) as doc:
        if doc.needs_pass or not doc.is_pdf: fail("简历 PDF 受密码保护或文件无效")
        if not 1 <= len(doc) <= 10: fail("请使用不超过 10 页的 PDF 简历")
        if doc.get_sigflags() > 0 or doc.is_form_pdf: fail("带签名或交互表单的 PDF 请先从原文件另存一份普通 PDF")
        info = layout(doc)
        info["sha256"] = hashlib.sha256(Path(args.input).read_bytes()).hexdigest()
        if not any(r["text"] for r in info["regions"]): fail("PDF 没有可编辑文字层，请使用原文件导出的文字 PDF")
        if args.action == "inspect":
            print(json.dumps(info, ensure_ascii=False))
            return
        if not args.edits or not args.output: fail("缺少 PDF 优化内容或输出位置")
        edits = json.loads(Path(args.edits).read_text(encoding="utf-8"))
        changes = apply_edits(doc, info, edits)
        out = Path(args.output)
        if Path(args.input).resolve() == out.resolve(): fail("原 PDF 必须保留，请选择新的输出文件")
        out.parent.mkdir(parents=True, exist_ok=True)
        doc.subset_fonts()
        doc.save(str(out), garbage=4, deflate=True)
    with fitz.open(str(out)) as final:
        actual = layout(final)
        if actual["pages"] != info["pages"]: fail("输出 PDF 页面与原文件不一致")
        def compact(t): return re.sub(r"\s", "", t)
        by_id = {region["id"]: region for region in info["regions"]}
        for change in changes:
            region = by_id[change["id"]]
            rect = fitz.Rect(region["bbox"])
            rect.x1 = rect.x0 + paragraph_width(final[change["page"] - 1], region, info)
            area = final[change["page"] - 1].get_textbox(rect + (-0.5, -0.5, 0.5, 0.5))
            if compact(change["after"]) not in compact(area):
                fail("输出 PDF 未完整保存优化文字")
        changed = {change["id"] for change in changes}
        for region in info["regions"]:
            area = final[region["page"] - 1].get_textbox(fitz.Rect(region["bbox"]) + (-0.5, -0.5, 0.5, 0.5))
            if region["id"] not in changed and compact(region["text"]) not in compact(area):
                fail("输出 PDF 未完整保留原文字区域 " + region["id"])
        for index, page in enumerate(final):
            page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False).save(str(out.parent / f"page-{index + 1}.png"))
        print(json.dumps({"pageCount": len(final), "changes": changes, "text": "\n\n".join(p.get_text(sort=True) for p in final)}, ensure_ascii=False))

if __name__ == "__main__":
    try: main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
