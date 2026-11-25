// 写入侧措辞契约：抽取器与反思器都不许把她写成「助手/助理」。
//
// 由来（2026-11-24）：线上 36 条记忆正文把她写成「助手/助理」（其中 11 条进了 preference 层），
// 而她的名字是助手、用户 11-19 已明确要求不要自称助手。
// 根因不是她的口癖，是写入这一步缺"怎么指代她自己"的规矩——模型只好默认用「助手」。
//
// 为什么这么测：提示词是模块内常量，用导出常量的方式测等于把实现抄一遍；
// 这里走真实入口 createHostExtractTurn / createHostReflectTurn，用假宿主截获真正发出去的 prompt，
// 断言的是"模型实际会看到什么"，任何人都没法靠删常量绕过。
const COG = new URL('../packages/cognition/lib/', import.meta.url).href;
const { createHostExtractTurn } = await import(`${COG}decide/host-extract.js`);
const { createHostReflectTurn } = await import(`${COG}decide/host-reflect.js`);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};

// 假宿主：截获 agent.followup 收到的 prompt，其余一律空转。
function captureHost() {
  const seen = { prompt: '' };
  const ctx = {
    get: key => (key === 'agents' ? {
      create: async () => ({
        agent: {
          session: { id: 'x' },
          ctx: {},
          followup: async message => {
            const blocks = message?.content ?? [];
            seen.prompt = blocks.filter(b => b?.type === 'text').map(b => b.text).join('\n');
          },
          whenIdle: async () => {}
        },
        dispose: async () => {}
      })
    } : undefined),
    on: () => () => {}
  };
  return { ctx, seen };
}

// ---------- 抽取器 ----------
{
  const { ctx, seen } = captureHost();
  const extractTurn = createHostExtractTurn({ ctx, logger: { warn() {} } });
  await extractTurn({ episodes: [{ id: 'ep1', at: 1, userText: '好啊，你可以多翻一点，捋捋然后给我讲。', selfText: '行，我多翻几条。' }] });
  const prompt = seen.prompt;
  check('抽取 prompt 已发出', prompt.length > 100, String(prompt.length));
  check('抽取 prompt 禁止用「助手」指代自己', /禁止[^\n]*助手/.test(prompt), prompt.slice(-160));
  check('抽取 prompt 要求用「我」', /一律用「我」/.test(prompt));
  check('抽取 prompt 明确覆盖转述用户说的话', /转述用户的话时同样/.test(prompt));
  check('抽取 prompt 给了正反例（不要写「用户让助手…」）', /不要写「用户让助手继续逛B站」/.test(prompt));
  check('抽取 prompt 保留原有规则（否定必须保留）', /否定必须保留/.test(prompt));
  check('抽取 prompt 保留原有规则（quote 校验）', /quote 会与原文核对/.test(prompt));
}

// ---------- 反思器 ----------
{
  const { ctx, seen } = captureHost();
  const reflectTurn = createHostReflectTurn({ ctx, logger: { warn() {} } });
  await reflectTurn({ episodes: [{ id: 'ep1', at: 1, userText: '你不该自称助手', selfText: '我记住了。' }] });
  const prompt = seen.prompt;
  check('反思 prompt 已发出', prompt.length > 100, String(prompt.length));
  check('反思 prompt 禁止用「助手」指代自己', /禁止[^\n]*助手/.test(prompt), prompt.slice(-160));
  check('反思 prompt 要求用「我」', /一律用「我」/.test(prompt));
  check('反思 prompt 覆盖"转述用户的意图"这种情形', /转述用户的意图/.test(prompt));
  check('反思 prompt 保留原有规则（evidence 至少一条）', /evidence 只能填/.test(prompt));
}

console.log(`\n结果：pass=${pass} fail=${fail}`);
if (fail > 0) process.exitCode = 1;
