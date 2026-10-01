const DEGREES = [
  { name: '初中', aliases: ['初中'], level: 0 },
  { name: '高中', aliases: ['高中'], level: 1 },
  { name: '中专', aliases: ['中专', '中技', '职高'], level: 1 },
  { name: '大专', aliases: ['大专', '专科'], level: 2 },
  { name: '本科', aliases: ['本科'], level: 3 },
  { name: '硕士', aliases: ['硕士'], level: 4 },
  { name: '博士', aliases: ['博士'], level: 5 },
];

/** 旧配置曾多选岗位学历；迁移时保留最低一项，避免把本科用户推断成硕士。 */
export function normalizeCandidateDegrees(raw: unknown): string[] {
  const selected = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const degrees = selected.flatMap((value) => {
    const degree = DEGREES.find((item) => item.aliases.includes(String(value).trim()));
    return degree ? [degree] : [];
  }).sort((a, b) => a.level - b.level);
  return degrees.length ? [degrees[0].name] : [];
}

export function checkEducationRequirement(jobDegree: string, candidateDegrees: string[]): { passed: boolean; reason?: string } {
  const candidateName = normalizeCandidateDegrees(candidateDegrees)[0];
  const candidate = DEGREES.find((item) => item.name === candidateName);
  if (!candidate || !jobDegree || /不限|无学历要求/.test(jobDegree)) return { passed: true };
  const requirements = DEGREES.filter((item) => item.aliases.some((alias) => jobDegree.includes(alias)))
    .sort((a, b) => a.level - b.level);
  const required = requirements[0];
  if (!required) return { passed: true };
  const exactOnly = /仅限|只招|仅接受/.test(jobDegree) && !/以上/.test(jobDegree);
  if ((exactOnly && !requirements.some((item) => item.level === candidate.level)) || (!exactOnly && candidate.level < required.level)) {
    return { passed: false, reason: exactOnly
      ? `学历要求不符（岗位明确限定 ${required.name}，你的学历 ${candidate.name}）`
      : `学历要求不符（岗位最低要求 ${required.name}，你的学历 ${candidate.name}）` };
  }
  return { passed: true };
}
