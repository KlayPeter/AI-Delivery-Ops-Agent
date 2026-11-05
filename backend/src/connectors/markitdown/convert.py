"""Local, stream-only bridge to the pinned upstream converter."""
import io
import json
import sys
import zipfile
from importlib.metadata import version
from markitdown import MarkItDown, StreamInfo

ENGINE_VERSION = version("markitdown")
if ENGINE_VERSION != "0.1.9":
    raise RuntimeError("Install the tested MarkItDown 0.1.9 release")
if len(sys.argv) == 1:
    print(json.dumps({"version": ENGINE_VERSION}))
    sys.exit(0)

extension = sys.argv[1]
if extension not in (".pdf", ".docx", ".pptx", ".xlsx", ".txt", ".md"):
    raise ValueError("Unsupported document type")
data = sys.stdin.buffer.read(10 * 1024 * 1024 + 1)
if not data or len(data) > 10 * 1024 * 1024:
    raise ValueError("Invalid input size")
if extension in (".docx", ".pptx", ".xlsx"):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 10000 or sum(item.file_size for item in entries) > 64 * 1024 * 1024:
            raise ValueError("Office document exceeds expansion budget")

result = MarkItDown(enable_plugins=False).convert_stream(io.BytesIO(data), stream_info=StreamInfo(extension=extension))
if not result.markdown.strip():
    raise ValueError("No readable text; scanned documents need OCR")
output = json.dumps({"markdown": result.markdown, "title": result.title, "version": ENGINE_VERSION}, ensure_ascii=False)
if len(output.encode("utf-8")) > 512 * 1024:
    raise ValueError("Converted text exceeds output budget")
print(output)
