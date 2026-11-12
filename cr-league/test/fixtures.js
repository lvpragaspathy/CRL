// Fake battle log entries shaped like GET /v1/players/{tag}/battlelog responses.
export const TAGS = { lucas: '#2PYQ8LV0', ava: '#Q8RL2YJ', ben: '#9VUG0P', stranger: '#CCCCCC' };

const ASSET = 'https://api-assets.clashroyale.com/cards/300/';
const card = (id, name, elixirCost, evo = 0) => ({ id, name, elixirCost, rarity: 'common', level: 14, maxLevel: 16, evolutionLevel: evo,
  iconUrls: { medium: ASSET + name.replace(/\W/g, '') + '.png', ...(evo ? { evolutionMedium: ASSET + name.replace(/\W/g, '') + '_evo.png' } : {}) } });
export const HOG_CYCLE = [card(26000021, 'Hog Rider', 4), card(28000011, 'The Log', 2), card(26000030, 'Ice Spirit', 1), card(26000010, 'Skeletons', 1, 1),
  card(26000038, 'Ice Golem', 2), card(28000009, 'Fireball', 4), card(26000014, 'Musketeer', 4), card(27000006, 'Cannon', 3)];
export const GOLEM = [card(26000009, 'Golem', 8), card(26000048, 'Night Witch', 4), card(26000035, 'Lumberjack', 4), card(26000063, 'Electro Dragon', 5),
  card(28000008, 'Zap', 2), card(26000017, 'Baby Dragon', 4), card(28000007, 'Tornado', 3), card(28000016, 'Lightning', 6)];
const TOWER = [{ id: 159000000, name: 'Tower Princess', rarity: 'common', iconUrls: { medium: ASSET + 'TowerPrincess.png' } }];

const side = (tag, name, crowns, king = 4824, princess = [3052, 3052], cards = [], elixirLeaked = 1.5) => {
  const s = { tag, name, crowns, princessTowersHitPoints: princess, cards, supportCards: cards.length ? TOWER : [], elixirLeaked };
  if (king) s.kingTowerHitPoints = king; // a destroyed king tower is missing from the log
  return s;
};

export const T1 = '20261112T201500.000Z'; // Lucas 3-1 Ava (friendly)
export const T2 = '20261112T203000.000Z'; // Lucas 1-1 Ben, Lucas wins tiebreaker on tower HP
export const T6 = '20261112T210000.000Z'; // Ava 0-2 Ben (clanMate)

export const logs = {
  [TAGS.lucas]: [
    { type: 'friendly', battleTime: T1, gameMode: { id: 72000006, name: 'Friendly' }, team: [side(TAGS.lucas, 'Lucas', 3, 4824, [], HOG_CYCLE)], opponent: [side(TAGS.ava, 'Ava', 1, 0, [], GOLEM)] },
    { type: 'friendly', battleTime: T2, gameMode: { id: 72000023, name: 'TripleElixir_Friendly' }, team: [side(TAGS.lucas, 'Lucas', 1, 4824, [1200])], opponent: [side(TAGS.ben, 'Ben', 1, 4824, [900])] },
    { type: 'PvP', battleTime: '20261112T190000.000Z', gameMode: { name: 'Ladder' }, team: [side(TAGS.lucas, 'Lucas', 1)], opponent: [side('#PPPPPP', 'Rando', 0)] },
    { type: 'friendly', battleTime: '20261112T180000.000Z', gameMode: { name: 'Friendly' }, team: [side(TAGS.lucas, 'Lucas', 2)], opponent: [side(TAGS.stranger, 'Not in league', 1)] },
    { type: 'clanMate2v2', battleTime: '20261112T170000.000Z', gameMode: { name: 'TeamVsTeam' }, team: [side(TAGS.lucas, 'Lucas', 1), side(TAGS.ava, 'Ava', 1)], opponent: [side(TAGS.ben, 'Ben', 0), side(TAGS.stranger, 'X', 0)] },
  ],
  [TAGS.ava]: [
    // Same battle as Lucas's first entry, seen from Ava's side
    { type: 'friendly', battleTime: T1, gameMode: { id: 72000006, name: 'Friendly' }, team: [side(TAGS.ava, 'Ava', 1, 0, [], GOLEM)], opponent: [side(TAGS.lucas, 'Lucas', 3, 4824, [], HOG_CYCLE)] },
    { type: 'clanMate', battleTime: T6, gameMode: { name: 'Friendly' }, team: [side(TAGS.ava, 'Ava', 0)], opponent: [side(TAGS.ben, 'Ben', 2)] },
  ],
  [TAGS.ben]: [
    { type: 'clanMate', battleTime: T6, gameMode: { name: 'Friendly' }, team: [side(TAGS.ben, 'Ben', 2)], opponent: [side(TAGS.ava, 'Ava', 0)] },
  ],
};
