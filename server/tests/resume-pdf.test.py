import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
import tempfile

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('resume_pdf', root / 'server/resources/resume-pdf.py')
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)
fitz = engine.fitz

def sha(data): return hashlib.sha256(data).hexdigest()
def compact(text): return ''.join(text.split())
def images(doc): return sorted(sha(doc.extract_image(item[0])['image']) for page in doc for item in page.get_images())

with tempfile.TemporaryDirectory(prefix='boss-pdf-test-', dir=root / 'data') as temporary:
    folder = Path(temporary)
    source = folder / 'source.pdf'
    doc = fitz.open()
    font = fitz.Font('cjk')
    original_body = '•负责频道内容策划与发布，每天筛选15条视频素材并完成剪辑，通过评论区互动引导商品页面转化。'
    second_body = '•借助AI编程助手开发桌面工具，支持素材搜索、批量上传和进度查看，减少日常重复操作。'
    picture = fitz.Pixmap(fitz.csRGB, (0, 0, 16, 16), False)
    for x in range(16):
        for y in range(16): picture.set_pixel(x, y, (x * 10, y * 10, 80))
    for index, body in enumerate([original_body, second_body]):
        page = doc.new_page(width=420, height=560)
        page.insert_font(fontname='ResumeOriginal', fontbuffer=font.buffer)
        page.insert_text((20, 45), '测试姓名', fontname='ResumeOriginal', fontsize=18)
        page.insert_text((20, 75), '13800000000  test@example.test', fontname='ResumeOriginal', fontsize=9)
        page.insert_image(fitz.Rect(340, 20, 385, 65), stream=picture.tobytes('png'))
        page.draw_line((20, 95), (385, 95), color=(0.2, 0.3, 0.4))
        page.insert_text((20, 122), '测试公司', fontname='ResumeOriginal', fontsize=12)
        lines = engine.wrap(body, 360, font, 10)
        for n, line in enumerate(lines): page.insert_text((20, 160 + 18 * n), line, fontname='ResumeOriginal', fontsize=10)
        page.insert_text((20, 330), '学历本科', fontname='ResumeOriginal', fontsize=12)
        page.insert_text((280, 330), '2018-2022', fontname='ResumeOriginal', fontsize=10)
    doc.save(source)
    doc.close()
    source_hash = sha(source.read_bytes())
    with fitz.open(source) as original:
        info = engine.layout(original)
        regions = [r for r in info['regions'] if r['editable']]
        assert len(regions) == 2
        new_bodies = ['•策划与发布频道内容，每天筛选15条视频并剪辑，通过评论互动引导商品页面转化。',
            '•借助AI编程助手开发桌面工具，支持素材搜索、批量上传与进度查看，减少重复操作。']
        edits = [{'id': r['id'], 'text': text} for r, text in zip(regions, new_bodies)]
        before_images = images(original)
        drawings = [[(d['type'], tuple(d['rect']), d['color']) for d in page.get_drawings()] for page in original]
        for invalid in [[{'id': info['regions'][0]['id'], 'text': '改名'}],
            [edits[0], edits[0]], [{'id': regions[0]['id'], 'text': new_bodies[0].replace('15', '20')}],
            [{'id': regions[0]['id'], 'text': '超长文字' * 100}]]:
            with fitz.open(source) as check:
                try: engine.apply_edits(check, info, invalid)
                except ValueError: pass
                else: raise AssertionError('不应接受受保护区域、重复项、数字变化或超长段落')
        edits_path = folder / 'edits.json'
        edits_path.write_text(json.dumps(edits, ensure_ascii=False), encoding='utf-8')
    command = [sys.executable, '-X', 'utf8', str(root / 'server/resources/resume-pdf.py'), 'edit',
        '--input', str(source), '--edits', str(edits_path)]
    exported = subprocess.run(command + ['--output', str(folder / 'optimized.pdf')], capture_output=True, text=True, encoding='utf-8')
    assert exported.returncode == 0, exported.stderr
    result = json.loads(exported.stdout.strip().splitlines()[-1])
    changes = result['changes']
    overwrite = subprocess.run(command + ['--output', str(source)], capture_output=True, text=True, encoding='utf-8')
    assert overwrite.returncode != 0 and '原 PDF 必须保留' in overwrite.stderr
    with fitz.open(folder / 'optimized.pdf') as final:
        assert len(final) == 2 and engine.layout(final)['pages'] == info['pages']
        assert images(final) == before_images, '照片像素必须保持'
        for page_no, page in enumerate(final):
            assert [(d['type'], tuple(d['rect']), d['color']) for d in page.get_drawings()] == drawings[page_no]
            assert compact(new_bodies[page_no]) in compact(page.get_text())
            assert '测试姓名' in page.get_text() and '13800000000' in page.get_text() and 'test@example.test' in page.get_text()
            assert '学历本科' in page.get_text() and '2018-2022' in page.get_text()
            page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False).save(folder / f'page-{page_no + 1}.png')
        assert len(changes) == 2
    assert sha(source.read_bytes()) == source_hash, '源 PDF 不能被覆盖'
print('PASS | 两页中文 PDF、原页面尺寸/照片/线条/个人事实、正文修改、数字保护、禁止覆盖与超长文本')
