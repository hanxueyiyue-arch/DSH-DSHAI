// 闹钟工具：注册进总线能力目录，让她自己设/看/删每天固定时间的提醒。
// 权限：写操作，但只影响她自己的日程（selfService），不对外界产生副作用。
export function registerAlarmTools(bus, getService) {
  if (!bus || typeof bus.registerTool !== 'function') return false;
  const service = () => getService();

  bus.registerTool('alarm.set', {
    readOnly: false,
    selfService: true,
    cost: 'free',
    description: '设一个每天固定时间的闹钟（例如每天 08:00 写日记）。只影响她自己的日程，不对外界做事。',
    args: {
      time: 'HH:MM，24 小时制，例如 08:00',
      label: '可选，一句话说明这个闹钟是干嘛的（≤60 字）'
    },
    async invoke(args = {}) {
      const result = await service().alarmToolSet(args);
      return JSON.stringify(result);
    }
  });

  bus.registerTool('alarm.list', {
    readOnly: true,
    selfService: true,
    cost: 'free',
    description: '列出她自己的闹钟（每天固定时间），含 id、时间、说明、今天是否已响过。',
    args: {},
    async invoke() {
      const result = await service().alarmToolList();
      return JSON.stringify(result);
    }
  });

  bus.registerTool('alarm.remove', {
    readOnly: false,
    selfService: true,
    cost: 'free',
    description: '删掉一个闹钟；需要先用 alarm.list 拿到 id。',
    args: { id: 'alarm.list 返回的 id' },
    async invoke(args = {}) {
      const result = await service().alarmToolRemove(args);
      return JSON.stringify(result);
    }
  });

  return true;
}
