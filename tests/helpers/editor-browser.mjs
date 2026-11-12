export const BUSY_EDIT = 'finish or cancel the current gesture/file operation before editing';

// Only use outside intentional gesture/file-operation refusal checks. This exact
// response comes from the guard before dispatch, so retry cannot duplicate edits.
// All validation/tool errors fail immediately; a stuck guard still fails the test.
export async function callEditorWhenIdle(page, name, args, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await page.evaluate(([n, a]) => editor.call(n, a), [name, args]);
    if (!result?.isError) return result;
    const busy = result.content?.length === 1 && result.content[0].type === 'text' && result.content[0].text === BUSY_EDIT;
    if (!busy) throw new Error(`${name}: ${JSON.stringify(result)}`);
    if (Date.now() >= deadline) throw new Error(`${name}: editor remained busy for ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
