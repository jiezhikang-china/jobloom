let owner = '';
/** A workflow lease, above the individual DOM action queue. */
export function acquireBossTask(name: string): () => void {
  if (owner) throw new Error('BOSS 正在执行' + owner + '，请稍后再试');
  owner = name;
  let released = false;
  return () => { if (!released) { released = true; owner = ''; } };
}
export function bossTaskOwner(): string { return owner; }
