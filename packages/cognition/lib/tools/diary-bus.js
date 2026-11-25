// 把"写/读/列日记"注册进总线能力目录：她能自己写日记，也能翻旧日记。
// 权限：create 只能写今天或补前一天；append/revise 只能改今天；补写的时间戳固定为当天。
export function registerDiaryTools(bus, getService) {
  if (!bus || typeof bus.registerTool !== 'function') return false;
  const service = () => getService();

  bus.registerTool('diary.write', {
    readOnly: false,
    selfService: true,
    cost: 'free',
    description: '写自己的日记。mode=create 新建（今天，或补写前一天）；mode=append 在今天末尾接着写；mode=revise 重写今天这篇（旧版会保留）。过去的日记已锁定，不能改。',
    args: {
      mode: 'create | append | revise',
      day: 'YYYY-MM-DD，默认今天；create 时最多补前一天',
      text: '日记正文，单篇 ≤20KB，写不下就新开一篇',
      mood: '可选，情绪标签（≤30 字）'
    },
    async invoke(args = {}) {
      const result = await service().diaryToolWrite(args);
      return JSON.stringify(result);
    }
  });

  bus.registerTool('diary.list', {
    readOnly: true,
    selfService: true,
    cost: 'free',
    description: '列出自己的日记（最新在前），含 id、日期、字数、修订数、是否可改。',
    args: { limit: [1, 100] },
    async invoke(args = {}) {
      const rows = await service().diaryToolList(args);
      return JSON.stringify(rows);
    }
  });

  bus.registerTool('diary.read', {
    readOnly: true,
    selfService: true,
    cost: 'free',
    description: '读一篇日记的正文；history=true 时附带最近几次修订（看自己改了什么）。',
    args: { id: '日记 id，例如 d-20261121', history: 'true 时附带修订历史' },
    async invoke(args = {}) {
      const result = await service().diaryToolRead(args);
      return JSON.stringify(result);
    }
  });

  return true;
}
