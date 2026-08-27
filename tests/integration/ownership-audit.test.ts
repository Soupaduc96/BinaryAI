import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A structural guard on account ownership.
 *
 * Every other ownership test proves that the routes which exist today behave
 * correctly. None of them can fail when someone adds a NEW route tomorrow that
 * reads an account id out of the query string — and that is the failure worth
 * catching, because it looks entirely reasonable in a diff:
 *
 *     const { accountId } = request.query;          // reads plausibly
 *     return repositories.ledger.list(accountId);   // serves anyone's ledger
 *
 * So this reads the API source and asserts a property about the shape of the
 * code rather than about one endpoint's response. It is deliberately narrow:
 * it does not try to understand the code, only to notice a caller-supplied
 * account identity reaching a query.
 *
 * The rule it encodes: ACCOUNT IDENTITY COMES FROM THE SESSION. A path
 * parameter may NAME an account, but `resolveAccount` then checks it against
 * the authenticated user before anything else runs. Nothing may take that
 * identity from a query string or a request body at all.
 */

const apiSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/api/src');

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
    }),
  );
  return files.flat();
}

describe('account identity may not come from the caller', () => {
  it('no route reads an account id from the query string or the body', async () => {
    const offenders: string[] = [];

    for (const file of await sourceFiles(apiSource)) {
      const source = await readFile(file, 'utf8');
      const lines = source.split('\n');

      lines.forEach((line, index) => {
        // Comments discuss this rule at length; they are not code.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');

        // `request.query.accountId`, `body.accountId`, destructuring out of
        // either, and the snake_case spelling a hand-written SQL layer invites.
        const reads =
          /\b(query|body)\s*\.\s*account_?[Ii]d\b/.test(code) ||
          /\baccount_?[Ii]d\b[^;]*=[^;]*\b(request\.query|request\.body|req\.query|req\.body)\b/.test(
            code,
          ) ||
          /\{[^}]*\baccount_?[Ii]d\b[^}]*\}\s*=\s*(request|req)\.(query|body)\b/.test(code);

        if (reads) offenders.push(`${path.relative(apiSource, file)}:${index + 1}: ${line.trim()}`);
      });
    }

    expect(offenders).toEqual([]);
  });

  it('no route declares an accountId query parameter in a schema', async () => {
    // The schema is where it would be legitimised. A validated `accountId`
    // query parameter is worse than an unvalidated one: it looks deliberate.
    const offenders: string[] = [];

    for (const file of await sourceFiles(apiSource)) {
      const source = await readFile(file, 'utf8');
      // Strip block comments, which explain at length why this is forbidden.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (/account_?[Ii]d\s*:\s*z\./.test(code)) {
        offenders.push(path.relative(apiSource, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('every account-scoped route file resolves ownership before serving', async () => {
    // `accounts.ts` is the only file serving `/v1/accounts/:id`. If a second
    // one appears, it must go through the same check rather than reimplement
    // it — a second implementation is a second chance to get it wrong.
    const files = await sourceFiles(path.join(apiSource, 'routes'));
    const serving: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/['"`]\/v1\/accounts\/:id/.test(source)) serving.push(file);
    }

    expect(serving.length).toBeGreaterThan(0);
    for (const file of serving) {
      const source = await readFile(file, 'utf8');
      expect(source).toContain('resolveAccount');
    }
  });

  it('resolves ownership from the session, not from the path parameter', async () => {
    // The specific line that makes a foreign account indistinguishable from a
    // missing one. Asserting on it means deleting it fails a test rather than
    // quietly turning the endpoint into an enumeration oracle.
    const source = await readFile(path.join(apiSource, 'routes/accounts.ts'), 'utf8');
    expect(source).toMatch(/account\.userId\s*!==\s*user\.id/);
  });
});
