import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOTS = ['app/admin', 'app/console', 'app/agents', 'components/admin'] as const;

const FILES = [
  'components/home/public-landing.tsx',
  'components/home/mechanism-cards.tsx',
  'components/stage/safety-notice.tsx',
  'components/generation/workshop-feed.tsx',
] as const;

const FORBIDDEN = [
  /本机(?!构)/,
  /磁盘/,
  /盘上/,
  /落盘/,
  /服务器/,
  /本站运维/,
  /本部署/,
  /当前这个部署/,
  /复算命令/,
  /source_id/,
  /\bschema\b/i,
  /\bunavailable\b/i,
  /MODEL_ROUTES|AUDIT_MODEL|ARBITER_MODEL/,
  /检索桥/,
  /管道故障/,
  /墙钟/,
  /旁路告警/,
  /为空数组/,
  /课堂角色/,
  /ArbitrationAgent/,
  /调 LLM/,
  /换库换模型/,
  /用户可选择模型|访客可选择/,
  /引擎无状态|客户端重发/,
  /判定字段缺失|门禁裁决字段/,
  /站有产物|本次接入产物|本轮产物/,
  /索引文件时间|索引与向量产物/,
] as const;

async function tsxFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) return tsxFiles(target);
      return entry.isFile() && entry.name.endsWith('.tsx') ? [target] : [];
    }),
  );
  return nested.flat();
}

function visibleLiterals(file: string, source: string): Array<{ line: number; text: string }> {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxText(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      const text = (node as ts.StringLiteralLike).text;
      if (FORBIDDEN.some((pattern) => pattern.test(text))) {
        found.push({
          line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
          text,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

describe('网站提供方可见文案边界', () => {
  it('限定页面的 JSX 可见文本不出现本机、磁盘或开发者内部术语', async () => {
    const base = process.cwd();
    const files = [
      ...(await Promise.all(ROOTS.map((root) => tsxFiles(path.join(base, root))))).flat(),
      ...FILES.map((file) => path.join(base, file)),
    ];
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const hit of visibleLiterals(file, source)) {
        violations.push(`${path.relative(base, file)}:${hit.line} ${JSON.stringify(hit.text)}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
