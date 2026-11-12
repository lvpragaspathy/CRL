// Fake battle log entries shaped like GET /v1/players/{tag}/battlelog responses.
export const TAGS = { lucas: '#2PYQ8LV0', ava: '#Q8RL2YJ', ben: '#9VUG0P', stranger: '#CCCCCC' };

const side = (tag, name, crowns, king = 4824, princess = [3052, 3052]) =>
  ({ tag, name, crowns, kingTowerHitPoints: king, princessTowersHitPoints: princess, cards: [] });

export const T1 = '20261112T201500.000Z'; // Lucas 3-1 Ava (friendly)
export const T2 = '20261112T203000.000Z'; // Lucas 1-1 Ben, Lucas wins tiebreaker on tower HP
export const T6 = '20261112T210000.000Z'; // Ava 0-2 Ben (clanMate)

export const logs = {
  [TAGS.lucas]: [
    { type: 'friendly', battleTime: T1, gameMode: { id: 72000006, name: 'Friendly' }, team: [side(TAGS.lucas, 'Lucas', 3, 4824, [])], opponent: [side(TAGS.ava, 'Ava', 1, 0, [])] },
    { type: 'friendly', battleTime: T2, gameMode: { id: 72000023, name: 'TripleElixir_Friendly' }, team: [side(TAGS.lucas, 'Lucas', 1, 4824, [1200])], opponent: [side(TAGS.ben, 'Ben', 1, 4824, [900])] },
    { type: 'PvP', battleTime: '20261112T190000.000Z', gameMode: { name: 'Ladder' }, team: [side(TAGS.lucas, 'Lucas', 1)], opponent: [side('#PPPPPP', 'Rando', 0)] },
    { type: 'friendly', battleTime: '20261112T180000.000Z', gameMode: { name: 'Friendly' }, team: [side(TAGS.lucas, 'Lucas', 2)], opponent: [side(TAGS.stranger, 'Not in league', 1)] },
    { type: 'clanMate2v2', battleTime: '20261112T170000.000Z', gameMode: { name: 'TeamVsTeam' }, team: [side(TAGS.lucas, 'Lucas', 1), side(TAGS.ava, 'Ava', 1)], opponent: [side(TAGS.ben, 'Ben', 0), side(TAGS.stranger, 'X', 0)] },
  ],
  [TAGS.ava]: [
    // Same battle as Lucas's first entry, seen from Ava's side
    { type: 'friendly', battleTime: T1, gameMode: { id: 72000006, name: 'Friendly' }, team: [side(TAGS.ava, 'Ava', 1, 0, [])], opponent: [side(TAGS.lucas, 'Lucas', 3, 4824, [])] },
    { type: 'clanMate', battleTime: T6, gameMode: { name: 'Friendly' }, team: [side(TAGS.ava, 'Ava', 0)], opponent: [side(TAGS.ben, 'Ben', 2)] },
  ],
  [TAGS.ben]: [
    { type: 'clanMate', battleTime: T6, gameMode: { name: 'Friendly' }, team: [side(TAGS.ben, 'Ben', 2)], opponent: [side(TAGS.ava, 'Ava', 0)] },
  ],
};
