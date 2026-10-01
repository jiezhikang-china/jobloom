// Adapted from Chat2API src/main/lib/challenge.ts, commit 59f03ab.
// Copyright (C) 2026 Chat2API Team. GPL-3.0-or-later; see LICENSE.
// Run the website's protocol calculation away from the login window's event loop.
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');

let wasmPromise;
async function solve(challenge) {
  if (challenge.algorithm !== 'DeepSeekHashV1') throw new Error('DeepSeek 协议算法已变化，请更新代理');
  if (!wasmPromise) {
    wasmPromise = fs.readFile(path.join(__dirname, 'sha3_wasm_bg.7b9ca65ddd.wasm'))
      .then((buffer) => WebAssembly.instantiate(buffer, { wbg: {} }))
      .then(({ instance }) => instance.exports);
  }
  const wasm = await wasmPromise;
  const encode = (value) => {
    const bytes = new TextEncoder().encode(value);
    const pointer = wasm.__wbindgen_export_0(bytes.length, 1) >>> 0;
    new Uint8Array(wasm.memory.buffer).set(bytes, pointer);
    return [pointer, bytes.length];
  };
  const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
  try {
    const [text, textLength] = encode(challenge.challenge);
    const [prefix, prefixLength] = encode(`${challenge.salt}_${challenge.expire_at}_`);
    wasm.wasm_solve(retptr, text, textLength, prefix, prefixLength, challenge.difficulty);
    const view = new DataView(wasm.memory.buffer);
    if (view.getInt32(retptr, true) === 0) throw new Error('DeepSeek 协议计算失败');
    return view.getFloat64(retptr + 8, true);
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}
parentPort.on('message', async (challenge) => {
  try { parentPort.postMessage({ answer: await solve(challenge) }); }
  catch { parentPort.postMessage({ error: 'DeepSeek 协议计算失败，请更新代理或稍后重试' }); }
});
