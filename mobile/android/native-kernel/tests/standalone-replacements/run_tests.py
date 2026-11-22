#!/usr/bin/env python3
"""CONTROL_FLOW_ONLY: compile source-extracted role/prerender guards with fakes.

Requires explicit --run or --prepare-only. No device, network, native build,
tracked-source modification, or cleanup. Each invocation retains a unique small
scratch directory and a result manifest, including the first failure.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

HERE = Path(__file__).parent
ROOT = HERE.parents[1]
LOADER = 'third_party/blink/renderer/core/loader/document_loader.cc'
SHELL = 'content/shell/browser/shell.cc'
SCOPE = 'third_party/blink/public/common/navigation/product_standalone_scope.h'


def need(ok, message):
    if not ok:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def section(text, start, end):
    need(text.count(start) == 1, 'nonunique start marker: ' + start)
    tail = text.split(start, 1)[1]
    need(end in tail, 'missing end marker: ' + end)
    return start + tail.split(end, 1)[0]


def method(text, marker):
    need(text.count(marker) == 1, 'nonunique method: ' + marker)
    start = text.index(marker)
    opening = text.index('{', start)
    # These selected small method bodies have no brace literals/comments.
    depth = 0
    for i in range(opening, len(text)):
        if text[i] == '{':
            depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    raise RuntimeError('unterminated method: ' + marker)


def android_block_after(text, marker):
    need(text.count(marker) == 1, 'nonunique Android block marker: ' + marker)
    tail = text.split(marker, 1)[1]
    need('#if BUILDFLAG(IS_ANDROID)' in tail, 'missing Android block after ' + marker)
    block = tail[tail.index('#if BUILDFLAG(IS_ANDROID)'):]
    return block.split('#endif', 1)[0] + '#endif'


def fragments(tree):
    loader = (tree / LOADER).read_text()
    header = (tree / LOADER.replace('.cc', '.h')).read_text()
    shell = (tree / SHELL).read_text()
    need('token_(params_->document_token)' in loader, 'production token constructor changed')
    need('product_standalone_scope_ = params_->product_standalone_scope;' in loader,
         'production scope constructor changed')
    clone = section(loader, '  auto params = std::make_unique<WebNavigationParams>();',
                    '  params->fallback_base_url = fallback_base_url_;')
    commit = loader.split('void DocumentLoader::CommitNavigation() {', 1)[1]
    return {
        'HAS_ROLE': method(header, '  bool HasProductStandaloneRole() const'),
        'CLONE_PRELUDE': clone,
        'CLONE_GUARD': '',
        'TAKE_SCOPE': android_block_after(commit, '  DCHECK_EQ(frame_->Tree().ChildCount(), 0u);'),
        'COMMIT_GUARD': android_block_after(commit, '  InitializeWindow(owner_document);'),
        'SAME_DOCUMENT_GUARD': android_block_after(loader, '  url_ = new_url;'),
        'REVOKE': method(loader, 'void DocumentLoader::RevokeProductStandaloneRole()'),
        'PRERENDER': method(shell, 'PreloadingEligibility Shell::IsPrerender2Supported('),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--run', action='store_true')
    mode.add_argument('--prepare-only', action='store_true')
    parser.add_argument('--pre', required=True, type=Path,
                        help='Read-only real source preimages for the product patch')
    parser.add_argument('--patch', type=Path,
                        default=ROOT / 'chromium/product-pwa.patch')
    parser.add_argument('--output-root', type=Path)
    parser.add_argument('--cxx', default=os.environ.get('CXX', 'c++'))
    parser.add_argument('--case', choices=('all', 'shell', 'renderer'), default='all')
    args = parser.parse_args()
    pre, patch = args.pre.resolve(strict=True), args.patch.resolve(strict=True)
    need(pre.is_dir() and patch.is_file(), 'invalid source/patch input')
    if args.output_root:
        need(args.output_root.is_dir(), '--output-root must exist')
    out = Path(tempfile.mkdtemp(prefix='standalone-replacements-', dir=args.output_root))
    report = {'scope': 'CONTROL_FLOW_ONLY', 'patchSha256': sha(patch.read_bytes()),
              'pre': str(pre), 'output': str(out), 'commands': [], 'status': 'FAILED',
              'limitations': ['GURL, SecurityOrigin, LocalFrame and DOMWindow are host fakes',
                              'InitializeWindow and actual Blink document installation are not run',
                              'No Chromium object compilation/link, browser activation, device, or emulator run']}

    def command(argv):
        result = subprocess.run(argv, capture_output=True, text=True, timeout=60,
                                env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})
        report['commands'].append({'argv': list(map(str, argv)), 'exit': result.returncode,
                                   'stdout': result.stdout, 'stderr': result.stderr})
        print(result.stdout, end='')
        if result.stderr:
            print(result.stderr, end='')
        need(result.returncode == 0, 'command failed: ' + ' '.join(map(str, argv)))

    try:
        tree = out / 'source'
        shutil.copytree(pre, tree)
        command(['git', '-C', str(tree), 'apply', '--whitespace=error', '--check', str(patch)])
        command(['git', '-C', str(tree), 'apply', '--whitespace=error', str(patch)])
        blocks = fragments(tree)
        report['extractedSha256'] = {key: sha(value.encode()) for key, value in blocks.items()}
        report['sourceSha256'] = {name: sha((tree/name).read_bytes()) for name in (LOADER, SHELL, SCOPE)}
        host = out / 'host'
        (host / 'url').mkdir(parents=True)
        shutil.copyfile(HERE/'gurl_host.h', host/'url/gurl.h')
        shutil.copyfile(tree/SCOPE, host/'product_standalone_scope.h')
        template = (HERE / 'host.cc.in').read_text()
        for android in (1, 0):
            source = template.replace('@ANDROID@', str(android))
            for key, value in blocks.items():
                source = source.replace('@' + key + '@', value)
            need(not re.search(r'@[A-Z_]+@', source), 'unfilled host template')
            source_path = host / ('host-android-' + str(android) + '.cc')
            source_path.write_text(source)
            if args.run:
                binary = source_path.with_suffix('')
                command([args.cxx, '-std=c++20', '-Wall', '-Wextra', '-Werror', '-pedantic',
                         '-Wno-unused-parameter', '-I' + str(host), str(source_path), '-o', str(binary)])
                cases = ('shell', 'renderer') if args.case == 'all' else (args.case,)
                for case in cases:
                    command([str(binary), case])
        report['status'] = 'PASS' if args.run else 'PREPARED_ONLY'
    except Exception as error:
        report['firstFailure'] = str(error)
        raise
    finally:
        (out/'result.json').write_text(json.dumps(report, indent=2, sort_keys=True)+'\n')
        print('Result manifest:', out/'result.json')


if __name__ == '__main__':
    main()
