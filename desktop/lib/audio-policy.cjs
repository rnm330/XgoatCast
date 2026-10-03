// Exact executable stems, matched case-insensitively with descendant process exclusion.
const DEFAULT_EXCLUSIONS = [
  { id: 'kook', label: 'KOOK / 开黑啦', names: ['kook', 'kaiheila', '开黑啦'] },
  { id: 'heychat', label: '黑盒语音', names: ['heyboxchat', 'heychat', '黑盒语音'] },
  { id: 'discord', label: 'Discord', names: ['discord', 'discordptb', 'discordcanary'] },
];
function buildExclusions(selected, executableNames) {
  if (!Array.isArray(selected) || !Array.isArray(executableNames) || executableNames.length > 256) throw new Error('无效的音频排除列表');
  const names = DEFAULT_EXCLUSIONS.filter(p => selected.includes(p.id)).flatMap(p => p.names);
  for (const name of executableNames) {
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\\/\x00-\x1f]/.test(name)) throw new Error('无效的软件名称');
    names.push(name.replace(/\.exe$/i, '').toLowerCase());
  }
  return [...new Set(names)];
}
module.exports = { DEFAULT_EXCLUSIONS, buildExclusions };
