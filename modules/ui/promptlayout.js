/**
 * 提示词段落编排 · 编辑器 UI（v0.9.53 起，v0.9.98 增强）
 *
 * ★ 设计前提（用户 2026-09-30 明确）：**段的内容不是用户手填的空壳，而是本楼剧情的产物**。
 *   「我选了角色段，它的内容就是这个楼剧情里的角色；选了场景段，内容就是这个楼的场景；
 *   选了动作段，内容就是这个楼的动作」—— 所以每段只管**排不排、排第几**，内容仍由
 *   processImage 从本楼分析结果与角色档案里取。这里不提供任何"自己写段内容"的入口。
 *
 * v0.9.98 增强（用户 2026-10-18：「哪些起作用、哪些没用、代价是什么都不知道」）：
 *   ① 按当前**引擎口径**如实标注每段有没有内容 —— SD 下的写实锚定/场景/服装恒空，
 *      以前勾了没反应，用户以为开关坏了；
 *   ② 每段显示**关闭代价**（关掉角色段 = 外貌全丢），hard 段红字；
 *   ③ 禁止关掉最后一段（否则拼出来的提示词是空的）；
 *   ④ 顶部一行讲清「当前口径 / 生效几段 / 实际走哪条拼装分支」。
 *
 * 编排分两层：
 *   全局：cfg.promptLayout（设置页，影响之后所有新图）
 *   单张：res.promptLayout（提示词编辑器里，只覆盖这一张；不填就跟随全局）
 */

import {
  PROMPT_BLOCKS, DEFAULT_PROMPT_ORDER, normalizeLayout, layoutConfigured,
  segmentApplicable, blockById,
} from '../promptLayoutCore.js';

export {
  PROMPT_BLOCKS, DEFAULT_PROMPT_ORDER, normalizeLayout, layoutHas,
  layoutConfigured, segmentApplicable, segmentOn, inapplicableBlocks,
} from '../promptLayoutCore.js';

const ENGINE_LABEL = { k2: 'K2 口径', sd: 'SD 口径' };

/**
 * 造一个段落编排编辑器。
 * @param {HTMLElement} host 容器
 * @param {() => object} getLayout 读当前编排
 * @param {(next:object) => void} setLayout 写回（调用方负责保存）
 * @param {object} [opts]
 *   hint:string      顶部提示
 *   getEngine:()=>'k2'|'sd'   当前口径（默认 k2）
 *   onChange:()=>void         每次改动后回调（让外部刷新状态行）
 */
export function buildLayoutEditor(host, getLayout, setLayout, opts = {}) {
  const engineOf = () => {
    const v = typeof opts.getEngine === 'function' ? opts.getEngine() : opts.engine;
    return v === 'sd' ? 'sd' : 'k2';
  };

  const paint = () => {
    host.replaceChildren();
    const cur = normalizeLayout(getLayout());
    const engine = engineOf();

    if (opts.hint) {
      const tip = document.createElement('div');
      tip.className = 'hl-layout-tip';
      tip.textContent = opts.hint;
      host.appendChild(tip);
    }

    /* ---- 状态行：说清"现在到底会怎么拼" ---- */
    const usable = PROMPT_BLOCKS.filter((b) => segmentApplicable(b.id, engine));
    const onNow = usable.filter((b) => (cur.order.includes(b.id) && !cur.off.includes(b.id)));
    const configured = layoutConfigured(getLayout());
    const status = document.createElement('div');
    status.className = 'hl-layout-status';
    status.textContent = [
      ENGINE_LABEL[engine],
      `生效 ${onNow.length} / ${usable.length} 段`,
      configured ? '按你排的顺序拼' : '未配置 → 出厂顺序',
    ].join(' · ');
    host.appendChild(status);

    const list = document.createElement('div');
    list.className = 'hl-layout-list';

    /* 按 order 的实际顺序显示；被关掉的段排最后；从未出现过的可选段（count）放更后 */
    const known = new Set([...cur.order, ...cur.off]);
    const optional = PROMPT_BLOCKS.map((b) => b.id).filter((id) => !known.has(id));
    const shown = [...cur.order, ...cur.off.filter((id) => !cur.order.includes(id)), ...optional];

    const isApplicable = (id) => segmentApplicable(id, engine);
    /** 关掉后还剩几段**有内容的段**（用于"不许全关"）。count 不算 —— 只剩人数词一样是废图。 */
    const othersOn = (id) => usable.filter((b) => b.id !== id && b.id !== 'count'
      && segmentOnLocal(cur, b.id) && isApplicable(b.id)).length;

    shown.forEach((id, i) => {
      const def = blockById(id);
      if (!def) return;
      const applicable = isApplicable(id);
      const isOptional = id === 'count';
      // count：勾 = 单独成段（进 order）；不勾 = 并入首段（默认行为）—— 它没有"关闭"这一态
      const on = isOptional
        ? cur.order.includes('count')
        : (cur.order.includes(id) && !cur.off.includes(id));

      const row = document.createElement('div');
      row.className = `hl-layout-row${on ? '' : ' hl-layout-row-off'}${applicable ? '' : ' hl-layout-row-na'}`;
      row.title = `${def.src}\n\n关掉这一段：${def.cost}`;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'hl-edit-ai-cb';
      cb.checked = on;
      if (!applicable) {
        cb.disabled = true;
        cb.title = `当前是 ${ENGINE_LABEL[engine]}，这一段在本口径下没有内容（不是开关坏了）`;
      } else if (isOptional) {
        cb.title = on ? '人数词单独成段（取消勾选 = 并回第一段）' : '勾上 = 人数词单独成段，可自己排位置';
      } else if (on && othersOn(id) === 0) {
        cb.disabled = true;
        cb.title = '不能把最后一段也关掉 —— 那样拼出来的提示词是空的';
      } else {
        cb.title = on ? `不输出这一段（${def.cost}）` : '把这一段加回提示词';
      }

      cb.addEventListener('change', () => {
        const base = normalizeLayout(getLayout());
        if (isOptional) {
          const has = base.order.indexOf('count');
          if (cb.checked) {
            base.off = base.off.filter((x) => x !== 'count');
            if (has < 0) base.order.push('count');
          } else if (has >= 0) {
            base.order.splice(has, 1);        // 取消定位 → 回到"并入首段"，不写 off
          }
          setLayout(base);
          paint();
          opts.onChange?.();
          return;
        }
        if (cb.checked) {
          base.off = base.off.filter((x) => x !== id);            // 重新启用
          if (!base.order.includes(id)) base.order.push(id);      // 回到末尾，位置自己再调
        } else {
          base.order = base.order.filter((x) => x !== id);
          if (!base.off.includes(id)) base.off.push(id);          // 记进 off，别被补全逻辑塞回来
        }
        setLayout(base);
        paint();
        opts.onChange?.();
      });

      const name = document.createElement('span');
      name.className = 'hl-layout-name';
      name.textContent = def.name;

      const mkMove = (dir, label) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'hl-layout-mv';
        b.textContent = label;
        b.disabled = !on || !applicable || (dir < 0 ? i === 0 : i >= shown.length - 1);
        b.title = dir < 0 ? '上移' : '下移';
        b.addEventListener('click', () => {
          const next = normalizeLayout(getLayout());
          const pos = next.order.indexOf(id);
          const swap = pos + dir;
          if (pos < 0 || swap < 0 || swap >= next.order.length) return;
          const arr = [...next.order];
          [arr[pos], arr[swap]] = [arr[swap], arr[pos]];
          next.order = arr;
          setLayout(next);
          paint();
          opts.onChange?.();
        });
        return b;
      };

      const badge = document.createElement('span');
      badge.className = 'hl-layout-badge';
      if (!applicable) {
        badge.textContent = '本口径无内容';
        badge.classList.add('is-na');
      } else if (isOptional) {
        badge.textContent = on ? '独立成段' : '并入首段';
        badge.classList.add(on ? 'is-on' : 'is-auto');
      } else if (on) {
        badge.textContent = '生效';
        badge.classList.add('is-on');
      } else {
        badge.textContent = '已关闭';
        badge.classList.add('is-off');
      }

      const info = document.createElement('span');
      if (!applicable) {
        info.className = 'hl-layout-src';
        info.textContent = '这一口径下没有这类段（SD 的场景与服装在模型 tag 里）';
      } else if (!on) {
        info.className = 'hl-layout-cost';
        info.textContent = `关掉 → ${def.cost}`;
        if (def.hard) info.classList.add('is-hard');
      } else {
        info.className = 'hl-layout-src';
        info.textContent = def.src;
      }

      row.appendChild(cb);
      row.appendChild(name);
      row.appendChild(mkMove(-1, '↑'));
      row.appendChild(mkMove(1, '↓'));
      row.appendChild(badge);
      row.appendChild(info);
      list.appendChild(row);
    });
    host.appendChild(list);

    // 服装独立成段：默认关 —— 关着的时候服装照旧附在角色段末尾，与旧版完全一致
    const sepWrap = document.createElement('label');
    sepWrap.className = 'hl-layout-sep';
    const sepCb = document.createElement('input');
    sepCb.type = 'checkbox';
    sepCb.className = 'hl-edit-ai-cb';
    sepCb.checked = cur.costumeSeparate;
    sepCb.disabled = !segmentApplicable('costume', engine);
    const sepText = document.createElement('span');
    sepText.textContent = segmentApplicable('costume', engine)
      ? '服装独立成段（勾上后服装从句从角色段里剥离，排在上面你指定的位置）'
      : `服装独立成段（${ENGINE_LABEL[engine]}下不适用 —— SD 的服装写在角色锚点里）`;
    sepCb.addEventListener('change', () => {
      const next = normalizeLayout(getLayout());
      next.costumeSeparate = sepCb.checked;
      setLayout(next);
      paint();
      opts.onChange?.();
    });
    sepWrap.appendChild(sepCb);
    sepWrap.appendChild(sepText);
    host.appendChild(sepWrap);

    if (!cur.costumeSeparate) {
      const note = document.createElement('div');
      note.className = 'hl-layout-tip';
      note.textContent = '提示：勾了「服装独立成段」却把「服装段」关掉 → 服装会整段消失（已在 v0.9.98 加了兜底，仍建议别这么配）。';
      host.appendChild(note);
    }
  };

  paint();
  return { refresh: paint };
}

/** 面板内部用：某个 id 在当前 layout 下是否输出（count 特例同 core）。 */
function segmentOnLocal(cur, id) {
  if (id === 'count') return !cur.off.includes('count');
  return cur.order.includes(id) && !cur.off.includes(id);
}
