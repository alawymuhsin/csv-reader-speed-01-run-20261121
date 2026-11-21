// A faster drop-in for csv-reader 1.0.0: run(input) returns exactly the answer
// csv-reader's readCsv returns for the same input {text, header}: the JSON value
// {columns, rows, errors}. It reads the same broken-row policy, one record at a
// time, left to right:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it one quote and each CRLF or lone CR inside it read as LF; what
//     follows its closing quote, up to the next comma or line break, is appended
//     as it stands (quote_junk, when the field ends); a quote that never closes
//     is a literal character, and the text after it is read again as unquoted
//     (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it (every record when header is false), each padded with ""
//     (short_row, with fields: its field count) or cut (long_row, with extra:
//     the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met, a field's quote_junk
//     when the field ends and a record's short_row or long_row when the record
//     ends: line the 1-based line its record starts on, counting every LF, CRLF
//     and lone CR inside quotes, and row its record's index in rows, null for
//     the header.
//
// Where the reference reads one character at a time and builds every field a
// character at a time, this reader jumps: an unquoted field is one regex search
// for the next comma or line break plus one slice, and a quoted field is found
// by indexOf jumps from quote to quote. A field is only ever assembled from
// slices, never character by character, so the work per field is a couple of
// native searches instead of a loop over its characters.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The next comma or line break from a position: one native search instead of a character loop.
  const DELIM = /[,\r\n]/g;
  // Line breaks inside a quoted field, each one LF in the value and one line counted.
  const BREAKS = /\r\n|\r|\n/g;

  // The general unquoted scan from pos, starting from `init`: it reads up to the next comma or line
  // break, dropping a CR not followed by LF (stray_cr). Its result is left in sv/se/sa, and pos and
  // line are moved past what it read.
  let sv = '';
  let se = END;
  let sa = 0;
  function scanUnquoted(init) {
    let v = init;
    let added = 0;
    let p = pos;
    for (;;) {
      DELIM.lastIndex = p;
      const m = DELIM.exec(text);
      if (m === null) {
        if (p < n) {
          v += text.slice(p);
          added += n - p;
        }
        p = n;
        sv = v;
        se = END;
        sa = added;
        pos = p;
        return;
      }
      const idx = m.index;
      // The delimiter's code, read from the text: the match itself is a
      // one-character string this never needs to build.
      const code = text.charCodeAt(idx);
      if (idx > p) {
        v += text.slice(p, idx);
        added += idx - p;
      }
      if (code === 44) {
        p = idx + 1;
        sv = v;
        se = COMMA;
        sa = added;
        pos = p;
        return;
      }
      if (code === 10) {
        p = idx + 1;
        line += 1;
        sv = v;
        se = LINE_BREAK;
        sa = added;
        pos = p;
        return;
      }
      // A CR: a line break when LF follows, else a stray CR, dropped.
      if (text.charCodeAt(idx + 1) === 10) {
        p = idx + 2;
        line += 1;
        sv = v;
        se = LINE_BREAK;
        sa = added;
        pos = p;
        return;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      p = idx + 1;
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let value;
    let ended;
    let lastQuoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        // A quoted field: find its closing quote by jumping from quote to quote.
        lastQuoted = true;
        const open = pos;
        const openLine = line;
        let q = pos + 1;
        let head = '';
        let closed = -1;
        for (;;) {
          const qi = text.indexOf('"', q);
          if (qi === -1) break;
          if (text.charCodeAt(qi + 1) === 34) {
            // A doubled quote: one literal quote, and the field goes on.
            head += text.slice(q, qi) + '"';
            q = qi + 2;
            continue;
          }
          closed = qi;
          break;
        }
        if (closed === -1) {
          // The quote never closes: it is a literal character, and the text after it is
          // read again as unquoted. The line is the one the field opened on.
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = open + 1;
          scanUnquoted('"');
          value = sv;
          ended = se;
        } else {
          let content = head + text.slice(q, closed);
          if (content.indexOf('\r') !== -1 || content.indexOf('\n') !== -1) {
            // CRLF and a lone CR inside quotes are each one LF, and each counts a line.
            content = content.replace(BREAKS, () => {
              line += 1;
              return '\n';
            });
          }
          pos = closed + 1;
          if (pos >= n) {
            value = content;
            ended = END;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              value = content;
              ended = COMMA;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              value = content;
              ended = LINE_BREAK;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              value = content;
              ended = LINE_BREAK;
            } else {
              // What follows the closing quote is appended as it stands, up to the next
              // comma or line break.
              scanUnquoted(content);
              value = sv;
              ended = se;
              if (sa > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            }
          }
        }
      } else {
        // An unquoted field: the nearest comma or line break ends it, found by two
        // indexOf searches that allocate nothing (a regex match would build a result
        // array per field). A quote inside it is a literal character. A CR in the
        // field is the CRLF ending when it is the field's last character and the
        // field ends at a line break; any other CR is a stray one, which the
        // general scan takes over for.
        lastQuoted = false;
        const ci = text.indexOf(',', pos);
        const ni = text.indexOf('\n', pos);
        if (ci === -1 && ni === -1) {
          // Nothing ends this field before the text does. A CR in what is left is
          // a lone one (a CRLF would have shown its LF), so the general scan
          // takes it; otherwise the rest of the text is the field.
          const rest = text.slice(pos);
          if (rest.indexOf('\r') === -1) {
            value = rest;
            pos = n;
            ended = END;
          } else {
            scanUnquoted('');
            value = sv;
            ended = se;
          }
        } else {
          let end;
          let isComma;
          if (ni === -1 || (ci !== -1 && ci < ni)) {
            end = ci;
            isComma = true;
          } else {
            end = ni;
            isComma = false;
          }
          value = text.slice(pos, end);
          const ri = value.indexOf('\r');
          if (ri === -1) {
            if (isComma) {
              pos = end + 1;
              ended = COMMA;
            } else {
              pos = end + 1;
              line += 1;
              ended = LINE_BREAK;
            }
          } else if (!isComma && ri === value.length - 1) {
            value = value.slice(0, -1);
            pos = end + 1;
            line += 1;
            ended = LINE_BREAK;
          } else {
            scanUnquoted('');
            value = sv;
            ended = se;
          }
        }
      }
      fields.push(value);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
