// Normalize human control inputs only. Never rewrite logs, citations, or artifact metadata.
export function trimInput(value) {
  return typeof value === 'string' ? value.trim() : value;
}

export function appendHiddenCharacter(value, character) {
  if (character === '\u007f' || character === '\b') return value.slice(0, -1);
  if (/\s/u.test(character) || character.charCodeAt(0) >= 32) return value + character;
  return value;
}

export function checkScriptInputs(arguments_, dataRoot) {
  if (arguments_.some((value) => value === '')) throw new Error('Command inputs cannot be empty or whitespace only');
  if (dataRoot === '') throw new Error('CLUTTA_PLAYGROUND_DATA_ROOT cannot be empty or whitespace only');
}
