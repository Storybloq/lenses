/**
 * Shared helper for wrapping untrusted values in `<untrusted-context>` blocks.
 *
 * Every value originating outside the server (tickets, project rules, scanner
 * output, prior-lens findings, glob-pattern config, etc.) must flow through
 * `untrusted()` before reaching the model. The Safety section of the preamble
 * instructs the model to treat the wrapped contents as data, not instructions.
 *
 * Factored into its own module so both `shared-preamble.ts` and individual
 * lens files (e.g. `security.ts`, `performance.ts`) import the same defanging
 * logic. Keeping one gatekeeper means we audit injection defenses in one
 * place, not eight.
 */

/** Zero-width space used to defang a smuggled closing-tag substring. */
export const ZWSP = "\u200B";

export const UNTRUSTED_CLOSE = "</untrusted-context>";

/**
 * Allowed shape for the `name` attribute. Names are emitted verbatim into the
 * `<untrusted-context name="...">` opening tag, so restricting them to a
 * conservative character set prevents a caller from smuggling attribute
 * payloads (quotes, angle brackets, whitespace) into the wrapper itself.
 */
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * Wrap an untrusted value in a delimited block so the model can distinguish
 * data from instructions. If the value contains the literal closing tag, we
 * splice in a zero-width space to break the match without changing the text's
 * semantic meaning.
 *
 * The `name` argument is a server-controlled label (never untrusted input)
 * but we still validate it so an accidental caller bug can't corrupt the
 * wrapper's opening tag.
 */
export function untrusted(name: string, body: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `untrusted(): invalid context name ${JSON.stringify(name)} -- must match ${String(NAME_PATTERN)}`,
    );
  }
  const safe = body.includes(UNTRUSTED_CLOSE)
    ? body.split(UNTRUSTED_CLOSE).join(`</${ZWSP}untrusted-context>`)
    : body;
  return `<untrusted-context name="${name}">\n${safe}\n</untrusted-context>`;
}
