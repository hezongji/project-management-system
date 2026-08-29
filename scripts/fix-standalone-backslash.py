# 修复 Next.js standalone 构建产物中 Windows 反斜杠 require 路径
# 依据 PM 跨平台部署坑①：Windows 构建的 .next/server chunk 里
# require("next\\dist\\client\\...") 在 Linux 上 Cannot find module
import glob
import re
import os

ROOT = '.next/standalone/.next'
count = 0
for f in glob.glob(os.path.join(ROOT, 'server', '**', '*.js'), recursive=True):
    try:
        with open(f, encoding='utf-8', errors='replace') as fh:
            src = fh.read()
    except Exception as e:
        print('SKIP', f, e)
        continue

    def fix(m):
        inner = m.group(2)
        # 双反斜杠(\\，即文件里的两个字符) → /
        inner = inner.replace('\\\\', '/')
        # 单反斜杠 → /
        inner = inner.replace('\\', '/')
        return m.group(1) + inner + m.group(3)

    new = re.sub(r"(require\([\"'])([^\"']*\\[^\"']*)([\"']\))", fix, src)
    if new != src:
        with open(f, 'w', encoding='utf-8', newline='') as fh:
            fh.write(new)
        count += 1

print('fixed files:', count)

# 验证残留
left = 0
for f in glob.glob(os.path.join(ROOT, 'server', '**', '*.js'), recursive=True):
    with open(f, encoding='utf-8', errors='replace') as fh:
        s = fh.read()
    if re.search(r"require\([\"'][^\"']*\\[^\"']*[\"']\)", s):
        left += 1
print('remaining files with backslash require:', left)
