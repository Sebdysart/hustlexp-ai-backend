import assert from 'node:assert/strict';
import { extractObjectFacts } from './extractObjectFacts.js';
import { resolveObjectReferences } from './resolveObjectReferences.js';
const CASES=[
 {input:'Disassemble my bed and assemble it again after moving.',expectedObject:'bed',expectedReference:'it'},
 {input:'Move my old washing machine outside and install the new one.',expectedObject:'washing machine',expectedReference:'new_one'},
 {input:'Buy three shelves, deliver them and install them in my garage.',expectedObject:'shelf',expectedReference:'them'},
 {input:'Pick up my bed and bring it upstairs.',expectedObject:'bed',expectedReference:'it'},
 {input:'Move two chairs and carry them upstairs.',expectedObject:'chair',expectedReference:'them'},
];
const failures:string[]=[];for(const testCase of CASES){const objects=extractObjectFacts(testCase.input);const references=resolveObjectReferences(testCase.input,objects);const match=references.find(r=>r.reference===testCase.expectedReference);try{assert.ok(match);assert.equal(match?.resolvedObject,testCase.expectedObject);}catch{failures.push([testCase.input,`expectedReference=${testCase.expectedReference}`,`expectedObject=${testCase.expectedObject}`,`objects=${JSON.stringify(objects)}`,`references=${JSON.stringify(references)}`].join(' | '));}}
if(failures.length){console.error(`Object reference failures: ${failures.length}/${CASES.length}`);for(const failure of failures)console.error(`- ${failure}`);process.exitCode=1;}else console.log(`Object reference cases passed: ${CASES.length}/${CASES.length}`);
