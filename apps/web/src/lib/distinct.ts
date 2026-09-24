/**
 * The distinct messages of a list, in first-seen order. Warning and issue lists render one
 * line per message and key each line by its text, so a message the server reports twice
 * would repeat a line and collide as a React key.
 */
export function distinct(messages: readonly string[]): readonly string[] {
  return [...new Set(messages)];
}
