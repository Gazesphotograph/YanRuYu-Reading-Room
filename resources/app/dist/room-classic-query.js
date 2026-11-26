const abbreviations = new Map(Object.entries({
  language: 'l', parody: 'p', character: 'c', group: 'g', artist: 'a',
  female: 'f', male: 'm', mixed: 'x', other: 'o', cosplayer: 'cos',
}));

function classicText(book, tags) {
  const fields = {};
  for (const key of ['title', 'title_jpn', 'status', 'filepath', 'url', 'pageDiff']) fields[key] = book[key];
  const groups = new Map();
  for (const { group, value } of tags) {
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(value);
  }
  fields.tags = [...groups].map(([group, values]) => [
    ...values.map(value => `${abbreviations.get(group) || group}:${value}`),
    ...values.map(value => `${group}:${value}`),
  ]);
  fields.category = `cat:${book.category}`;
  return JSON.stringify(fields).toLowerCase();
}

function comparison(term) {
  const rule = /^:(mtime|atime|ptime|count)([<>=])(.*)$/.exec(term);
  if (!rule) return () => false;
  const [, field, operator, value] = rule;
  if (field === 'count') {
    const count = Number.parseInt(value, 10);
    return book => operator === '=' ? book.readCount === count : operator === '>' ? book.readCount > count : book.readCount < count;
  }
  const expected = new Date(value);
  const key = { mtime: 'mtime', atime: 'date', ptime: 'posted' }[field];
  return book => {
    const date = new Date(field === 'ptime' ? book.posted * 1000 : book[key]);
    if (operator === '=') return date.toLocaleDateString() === expected.toLocaleDateString();
    return operator === '>' ? date >= expected : date <= expected;
  };
}

export function compileClassicQuery(query) {
  if (!query) return null;
  const required = [], alternatives = [];
  // The classic manager treats the AND group (even an empty group) as one OR branch.
  for (const term of query.split(/\s+(?=(?:[^'"]*['"][^'"]*['"])*[^'"]*$)/)) {
    if (term.startsWith(':')) {
      required.push(comparison(term));
      continue;
    }
    const alternative = term.startsWith('~'), excluded = term.startsWith('-');
    const literal = (alternative || excluded ? term.slice(1) : term).replace(/["']/g, '').replace(/\$/g, '"').toLowerCase();
    const matches = (book, metadata) => {
      metadata.classicText ??= classicText(book, metadata.tags);
      return metadata.classicText.includes(literal) !== excluded;
    };
    (alternative ? alternatives : required).push(matches);
  }
  return (book, metadata) => required.every(test => test(book, metadata)) || alternatives.some(test => test(book, metadata));
}
