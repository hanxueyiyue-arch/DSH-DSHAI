export function socialTransportMode(value) {
  if (value === 'real-send') return { readEnabled: true, sendEnabled: true, enabled: true };
  if (value === 'real-read') return { readEnabled: true, sendEnabled: false, enabled: true };
  return { readEnabled: false, sendEnabled: false, enabled: false };
}
