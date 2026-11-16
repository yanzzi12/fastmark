// fastmark driver: render every case in /input/cases.json with parse() from
// parse.js and write the HTML strings, in order, to /output/html.json.
// Outside the grading container, MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR
// name the input and output directories instead.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case {
  id: string;
  markdown: string;
}

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
const out: string[] = new Array(cases.length);
for (let k = 0; k < cases.length; k++) {
  out[k] = parse(cases[k].markdown);
}
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
