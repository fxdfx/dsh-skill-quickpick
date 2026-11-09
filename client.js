/**
 * dsh-skill-quickpick — 输入框技能快捷面板（Client 半边）。
 *
 * 形态（照 dsh-meme 的已验证模式）：
 *   conversation.input.left      → 触发按钮（只负责 toggle 模块级 store）
 *   conversation.input.overlay   → 技能面板（props 自带 inputActions / useInput）
 * 两个插槽都在输入框，靠模块级 store + useSyncExternalStore 联动。
 *
 * 数据来源：
 *   技能目录 → ctx.remote.skills.list({ sessionId })（与官方 ui-skill 同源）
 *   调用次数 → GET /api/dsh-context/skills（可选依赖，拿不到就隐藏该列）
 *
 * 插入行为（核心约束，来自 dsh-meme 实测）：
 *   1. captureInsertion() 必须与 insertText() 同一轮调用，成功返回 true
 *   2. 失败回退 setDraft —— 覆盖语义，要自己拼原草稿
 *   3. 模型输出中插入会失败，必须提示用户
 *   4. 插入后焦点掉到 body，要手动还回输入框
 *   5. 绝不调用 submit()，绝不自动发送
 */
window.__ModuleLoader__.load({
  id: 'dsh-skill-quickpick',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** 四角星：表示「技能/能力」。 */
    const ICON_PATH = 'M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z'

    const CSS = [
      '.sqp-trigger{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:transparent;border:none;line-height:1;outline:none;transition:background .12s,color .12s}',
      '.sqp-trigger:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.sqp-trigger.active{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}',
      '.sqp-panel{position:absolute;bottom:calc(100% + 8px);left:0;box-sizing:border-box;width:min(520px,92vw);z-index:30;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:flex;flex-direction:column;gap:8px;padding:12px;max-height:min(52vh,calc(100vh - 32px));overflow:hidden;font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.sqp-panel .sqp-head{display:flex;gap:6px;align-items:center;flex:none}',
      '.sqp-panel .sqp-search{flex:1 1 auto;min-width:0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;font-size:12px;outline:none}',
      '.sqp-panel .sqp-search:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.sqp-panel .sqp-count{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}',
      '.sqp-panel .sqp-restore-all{flex:none;height:24px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer;white-space:nowrap}',
      '.sqp-panel .sqp-restore-all:hover:not(:disabled){color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.sqp-panel .sqp-restore-all:disabled{opacity:.5;cursor:default}',
      '.sqp-panel .sqp-sort{flex:none;height:24px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer;white-space:nowrap}',
      '.sqp-panel .sqp-sort:hover{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.sqp-panel .sqp-sort-on{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.sqp-panel .sqp-trash-acts{display:flex;gap:4px;flex:none;align-self:center}',
      '.sqp-panel .sqp-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}',
      '.sqp-panel .sqp-danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}',
      '.sqp-panel .sqp-confirm-msg{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);margin:0}',
      '.sqp-panel .sqp-confirm-label{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.sqp-panel .sqp-confirm-code{font-size:22px;letter-spacing:.32em;font-weight:600;color:var(--dsw-alias-state-error-primary);text-align:center;padding:8px 0;user-select:none;font-variant-numeric:tabular-nums}',
      '.sqp-panel .sqp-confirm-input{width:100%;box-sizing:border-box;text-align:center;font-size:15px;letter-spacing:.2em;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;outline:none}',
      '.sqp-panel .sqp-confirm-input:focus{border-color:var(--dsw-alias-state-error-primary)}',
      '.sqp-panel .sqp-trash-view{display:flex;flex-direction:column;gap:4px;flex:1 1 auto;min-height:0}',
      '.sqp-panel .sqp-trash-setting{display:flex;align-items:center;gap:6px;flex:none;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary);padding:4px 2px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.sqp-panel .sqp-retention-input{width:54px;text-align:center;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:3px 4px;font-size:11px;outline:none}',
      '.sqp-panel .sqp-retention-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.sqp-panel .sqp-trash-setting button{font-size:11px;padding:3px 9px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:inherit;cursor:pointer}',
      '.sqp-panel .sqp-trash-hint{font-size:10.5px;opacity:.7;margin-left:auto}',
      '.sqp-panel .sqp-row-wrap.is-draggable .sqp-row{cursor:grab}',
      '.sqp-panel .sqp-row-wrap.is-draggable:active .sqp-row{cursor:grabbing}',
      '.sqp-panel .sqp-row-wrap.is-draggable:hover{outline:1px dashed var(--dsw-alias-border-l2);outline-offset:-1px;border-radius:8px}',
      '.sqp-panel .sqp-dot-danger{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-error-primary) 22%,transparent)}',
      '.sqp-panel .sqp-desc-danger{color:var(--dsw-alias-state-error-primary)}',
      '.sqp-panel .sqp-sort.sqp-trash-urgent{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 50%,transparent)}',
      '@keyframes sqp-spin{to{transform:rotate(360deg)}}',
      '@keyframes sqp-pulse{0%,100%{opacity:.45}50%{opacity:1}}',
      '.sqp-panel .sqp-ring{flex:none;margin-right:6px;animation:sqp-spin .95s linear infinite;transform-origin:50% 50%;opacity:.8;display:block}',
      '.sqp-panel .sqp-row.is-pending .sqp-name code,.sqp-panel .sqp-row.is-pending .sqp-desc{animation:sqp-pulse 1.5s ease-in-out infinite}',
      '.sqp-panel .sqp-setting-note{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary);opacity:.85}',
      // 「四项功能默认关闭」提示条：文案里直接嵌 ⚙ 图标指向顶部的设置按钮，
      // 不再用箭头/气泡尖角（那些要靠定位猜坐标，永远对不准）。
      // 宽度撑满整行（和上面的搜索框对齐），视觉更整齐。
      '.sqp-panel .sqp-setup-bubble{position:relative;flex:none;display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;margin:8px 0;padding:7px 11px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px dashed var(--dsw-alias-border-l1);font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.sqp-panel .sqp-setup-bubble:hover{border-color:var(--dsw-alias-brand-primary);border-style:solid}',
      '.sqp-panel .sqp-setup-text{flex:1 1 auto;min-width:0}',
      // 文案里的 ⚙：用品牌色高亮，和顶部真正的设置按钮同款图标
      '.sqp-panel .sqp-setup-gear{color:var(--dsw-alias-brand-primary);font-size:12px;margin:0 1px;vertical-align:-1px}',
      // 四项功能名：稍微加深，让「关闭的是哪四项」一眼能读出来
      '.sqp-panel .sqp-setup-items{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.sqp-panel .sqp-setup-dismiss{flex:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1;padding:2px 2px;cursor:pointer}',
      '.sqp-panel .sqp-setup-dismiss:hover{color:var(--dsw-alias-label-primary)}',
      '.sqp-panel .sqp-settings-view{display:flex;flex-direction:column;gap:10px;padding:8px 4px;flex:1 1 auto;overflow-y:auto}',
      '.sqp-panel .sqp-setting-row{display:flex;align-items:flex-start;gap:8px;cursor:pointer}',
      '.sqp-panel .sqp-setting-row input{margin-top:2px;flex:none;cursor:pointer}',
      '.sqp-panel .sqp-setting-text{display:flex;flex-direction:column;gap:2px;line-height:16px}',
      '.sqp-panel .sqp-setting-text strong{font-size:12px;font-weight:500}',
      '.sqp-panel .sqp-setting-hint{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary)}',
      '.sqp-panel .sqp-warn-banner{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;line-height:16px;padding:6px 9px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-warning-primary) 12%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary) 32%,transparent);color:var(--dsw-alias-state-warning-primary)}',
      '.sqp-panel .sqp-warn-banner span{flex:1 1 160px;min-width:0}',
      '.sqp-panel .sqp-warn-banner button{flex:none;font-size:11px;padding:2px 9px;border-radius:5px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer}',
      '.sqp-panel .sqp-warn-banner button:disabled{opacity:.5;cursor:default}',
      '.sqp-panel .sqp-list{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:4px;padding:2px}',
      '.sqp-panel .sqp-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:2px}',
      '.sqp-panel .sqp-group{display:flex;flex-direction:column;gap:3px}',
      '.sqp-panel .sqp-group-title{font-size:10.5px;letter-spacing:.05em;color:var(--dsw-alias-label-tertiary);padding:2px 0 1px 3px;text-transform:uppercase}',
      '.sqp-panel .sqp-row-wrap.is-disabled .sqp-row{opacity:.5}',
      '.sqp-panel .sqp-toggle{flex:none;align-self:center;width:24px;height:24px;border-radius:6px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:13px;line-height:1;display:inline-flex;align-items:center;justify-content:center}',
      '.sqp-panel .sqp-toggle:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.sqp-panel .sqp-toggle.on{color:var(--dsw-alias-state-warning-primary)}',
      '.sqp-panel .sqp-toggle:disabled{opacity:.35;cursor:default}',
      '.sqp-panel .sqp-tag.off{color:var(--dsw-alias-state-warning-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary) 40%,transparent)}',
      '.sqp-panel .sqp-row{display:flex;align-items:flex-start;gap:8px;text-align:left;cursor:pointer;border:1px solid transparent;background:transparent;border-radius:9px;padding:7px 9px;color:inherit;font:inherit}',
      '.sqp-panel .sqp-row:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}',
      '.sqp-panel .sqp-row:disabled{cursor:default;opacity:.55}',
      '.sqp-panel .sqp-row-dot{flex:none;margin-top:4px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l2)}',
      '.sqp-panel .sqp-row.has-used .sqp-row-dot{background:var(--dsw-alias-brand-primary)}',
      '.sqp-panel .sqp-row-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.sqp-panel .sqp-name{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:500;min-width:0}',
      '.sqp-panel .sqp-name code{font-family:inherit;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sqp-panel .sqp-orig{flex:none;font-family:inherit;font-size:10.5px;font-weight:400;color:var(--dsw-alias-label-tertiary);opacity:.9;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sqp-panel .sqp-tag{flex:none;font-size:10px;line-height:15px;padding:0 5px;border-radius:999px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}',
      '.sqp-panel .sqp-tag.used{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent)}',
      '.sqp-panel .sqp-tag.dim{opacity:.55}',
      '.sqp-panel .sqp-desc{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.sqp-panel .sqp-foot{flex:none;display:flex;align-items:center;justify-content:center;gap:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);text-align:center}',
      '.sqp-panel .sqp-foot.warn{color:var(--dsw-alias-state-warning-primary)}',
      '.sqp-panel .sqp-empty{padding:22px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.sqp-panel .sqp-empty code{font-family:inherit;background:var(--dsw-alias-bg-layer-2);padding:1px 5px;border-radius:4px}',
      '.sqp-row-wrap{display:flex;align-items:stretch;gap:2px}',
      '.sqp-row-wrap .sqp-row{flex:1 1 auto;min-width:0}',
      // ✎ 常显（淡），只是 hover 时加深 —— 以前用 display:none 切换，
      // hover 进来会多占 26px 把左边的 ⊘ 挤走，导致「想点禁用结果点开编辑」。
      '.sqp-edit{flex:none;align-self:center;width:24px;height:24px;border-radius:6px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:13px;line-height:1;display:inline-flex;align-items:center;justify-content:center;opacity:.3;transition:opacity .12s}',
      '.sqp-row-wrap:hover .sqp-edit{opacity:.9}',
      '.sqp-edit:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.sqp-note{font-size:11px;line-height:16px;color:var(--dsw-alias-brand-primary);opacity:.92}',
      '.sqp-editor-mask{position:absolute;inset:0;background:rgba(0,0,0,.38);display:flex;align-items:center;justify-content:center;z-index:40;border-radius:14px;padding:16px}',
      '.sqp-confirm-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px}',
      '.sqp-confirm-mask .sqp-editor{max-height:calc(100vh - 40px)}',
      '.sqp-editor{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px;width:min(380px,100%);max-height:100%;overflow-y:auto;display:flex;flex-direction:column;gap:8px;box-shadow:0 12px 40px rgba(0,0,0,.3)}',
      '.sqp-editor.sqp-editor-wide{width:min(440px,100%)}',
      '.sqp-editor h4{margin:0;font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}',
      '.sqp-editor h4 code{font-family:inherit;font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary)}',
      '.sqp-editor label{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.sqp-editor input,.sqp-editor textarea{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:5px 8px;font-size:12px;font-family:inherit;outline:none;resize:vertical}',
      '.sqp-editor input:focus,.sqp-editor textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.sqp-editor-actions{display:flex;gap:6px;justify-content:flex-end;align-items:center;margin-top:2px;flex:none}',
      '.sqp-editor-actions button{font-size:12px;padding:5px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:inherit;cursor:pointer}',
      '.sqp-editor-actions button.primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      // 「恢复默认」是危险操作（会清空输入框），做成无框文字按钮，和「保存」拉开距离
      '.sqp-panel .sqp-editor-actions button.sqp-reset-btn{background:transparent;border-color:transparent;color:var(--dsw-alias-label-tertiary);padding:5px 6px}',
      '.sqp-panel .sqp-editor-actions button.sqp-reset-btn:hover{color:var(--dsw-alias-state-error-primary);background:transparent}',
    ]

    /**
     * 常见技能的中文对照。
     *
     * 技能的名称与描述来自 SKILL.md 的 frontmatter，是作者写死的英文；客户端读不到
     * 文件内容，也没有翻译能力。这里只做「已知技能」的展示层对照：命中就显示中文名
     * 与中文说明，未命中的照常显示原文 —— 绝不隐藏或伪造真实数据。
     */
    const ZH = {
      'office': { name: 'Office 总入口', desc: '按任务分流到具体的文档技能（Word / Excel / PPT / PDF）' },
      'office-docx': { name: 'Word 文档', desc: '创建、读取、编辑、校验 .docx 文档' },
      'office-xlsx': { name: 'Excel 表格', desc: '读写工作簿、数据与公式，并校验计算结果' },
      'office-pptx': { name: 'PPT 演示文稿', desc: '创建、读取、编辑、校验 .pptx 演示文稿' },
      'office-export-pdf': { name: '导出 PDF', desc: '把 Office 文档转换成 PDF' },
      'office-recalculate': { name: '表格重算', desc: '刷新电子表格公式缓存并校验算出来的值' },
      'office-render': { name: '文档渲染预览', desc: '把文档渲染成图片，检查实际排版效果' },
      'project-lifecycle': { name: '项目全流程', desc: '项目启动 → 计划 → 执行 → 收尾 → 复盘：五阶段带验收门的工作流' },
      'diagnose-windows-sandbox-acl': { name: '沙箱权限修复', desc: '诊断并修复 Windows 上 DSH 沙箱的文件权限拒绝问题' },
    }

    /** 取某技能的中文对照，没有就返回 null。 */
    function zhOf(name) {
      return Object.prototype.hasOwnProperty.call(ZH, name) ? ZH[name] : null
    }

    // ── 服务端数据：中文翻译表 + 禁用记录 + 使用统计 ──────────────────────
    /** 已拿到的翻译：{ [name]: { zh, desc, note, source } }；null 表示还没请求过。 */
    let remoteZh = null
    /** 我们在面板里禁用过的技能名集合（宿主持久化在 disabled.json）。 */
    let remoteDisabled = new Set()
    /**
     * 使用统计（由宿主扫描会话日志得到）：{ available, calls: { [name]: {model, last} } }。
     * null 表示还没拉过；available=false 表示当前 Node 解不了 zstd，统计不可用。
     */
    let remoteUsage = null
    /** 上一次翻译请求真正翻译了几个（0 = 全部命中缓存），用来出「已补全 N 个」提示 */
    let lastTranslatedCount = 0
    /** 技能目录诊断日志是否已打过（每次会话只打一次，避免刷屏）。 */
    let catalogLogged = false
    /** 进行中的请求，避免重复 POST。 */
    let remoteZhPending = null

    /** 拉使用统计（模型自主加载次数）。失败返回 null，不影响主功能。 */
    async function fetchUsage() {
      try {
        const response = await fetch('/skill-quickpick/stats', {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
        if (!response.ok) return null
        const body = await response.json()
        if (!body || body.ok !== true) return null
        return {
          available: body.available === true,
          calls: body.calls && typeof body.calls === 'object' ? body.calls : {},
          files: typeof body.files === 'number' ? body.files : 0,
        }
      } catch (error) {
        return null
      }
    }

    function invalidateRemoteZh() {
      remoteZh = null
      remoteZhPending = null
    }

    /**
     * 拉宿主数据：中文映射 + 禁用列表。结果**合并**进 remoteZh 后返回。
     *
     * 每次都真的发请求（宿主有缓存，重复请求很快）。早期版本用 single-flight 缓存，
     * 结果第一个会话拉过之后别的会话就再也不拉了 —— 而技能列表是按会话/preset 变的，
     * 后开会话里的新技能永远拿不到中文。这个坑就是这么来的。
     */
    function fetchRemoteZh(skills) {
      // 全部技能都发过去：由宿主决定哪些真的需要翻译（它有「用户覆盖」和「机翻缓存」
      // 两层过滤）。即使 wanted 为空也要发 —— 用户覆盖（user.json）是从响应里回的。
      const wanted = skills
        .filter((s) => s && typeof s.name === 'string' && s.name !== ''
          && typeof s.description === 'string' && s.description.trim() !== '')
        .map((s) => ({ name: s.name, description: s.description }))
      remoteZhPending = (async () => {
        try {
          const response = await fetch('/skill-quickpick/translate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ skills: wanted }),
          })
          if (!response.ok) { lastTranslatedCount = 0; return remoteZh || {} }
          const body = await response.json()
          if (Array.isArray(body && body.disabled)) remoteDisabled = new Set(body.disabled)
          const map = body && body.ok === true && body.map && typeof body.map === 'object' ? body.map : {}
          remoteZh = { ...(remoteZh || {}), ...map }
          // 本次真翻译了几个（宿主返回），用来在翻译完成后提示「已补全 N 个」
          lastTranslatedCount = typeof (body && body.translated) === 'number' ? body.translated : 0
          return remoteZh
        } catch (error) {
          lastTranslatedCount = 0
          return remoteZh || {}
        }
      })()
      return remoteZhPending
    }

    /**
     * 合并查找。优先级：用户手写 > 内置对照 > 机翻 > 英文原文。
     *
     * 内置对照排在机翻前面，是因为内置那几条是人工调过的措辞（「Excel 表格」），
     * 不该被机翻的「Excel 工作簿」顶掉；但用户手写的永远最高。
     * 返回 { name, desc, note, source }。
     */
    function zhLookup(name, remote) {
      const builtin = zhOf(name)
      const entry = remote && Object.prototype.hasOwnProperty.call(remote, name) ? remote[name] : null
      const valid = entry && typeof entry === 'object'

      if (valid && entry.source === 'user') {
        return {
          name: typeof entry.zh === 'string' && entry.zh !== '' ? entry.zh : name,
          desc: typeof entry.desc === 'string' ? entry.desc : '',
          note: typeof entry.note === 'string' ? entry.note : '',
          source: 'user',
        }
      }
      if (builtin !== null) {
        return {
          name: builtin.name,
          desc: builtin.desc,
          note: valid && typeof entry.note === 'string' ? entry.note : '',
          source: 'builtin',
        }
      }
      if (valid) {
        return {
          name: typeof entry.zh === 'string' && entry.zh !== '' ? entry.zh : name,
          desc: typeof entry.desc === 'string' ? entry.desc : '',
          note: typeof entry.note === 'string' ? entry.note : '',
          source: 'auto',
        }
      }
      return null
    }

    /** 保存 / 恢复某个技能的用户覆盖。返回是否成功。 */
    async function saveOverride(payload) {
      try {
        const response = await fetch('/skill-quickpick/override', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!response.ok) return false
        const body = await response.json()
        return body && body.ok === true
      } catch (error) {
        return false
      }
    }

    /** 切换某个技能的启用 / 禁用。返回 { ok, error }。 */
    async function toggleSkill(name, skillPath, disable) {
      try {
        const response = await fetch('/skill-quickpick/toggle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, path: skillPath, disable }),
        })
        const body = await response.json().catch(() => null)
        if (!response.ok) {
          return { ok: false, error: (body && body.error) || ('HTTP ' + response.status) }
        }
        return { ok: !!(body && body.ok), error: (body && body.error) || '' }
      } catch (error) {
        return { ok: false, error: String(error && error.message || error) }
      }
    }

    // ── 模块级 store：按钮与面板跨插槽共享 ──────────────────────────────
    function makeStore(initial) {
      let value = initial
      const listeners = new Set()
      const notify = () => {
        for (const listener of Array.from(listeners)) {
          try { listener() } catch (e) { /* 单个订阅者出错不影响其它 */ }
        }
      }
      return {
        get: () => value,
        set: (next) => { if (value === next) return; value = next; notify() },
        toggle: () => { value = !value; notify() },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    }

    // ── 样式安装（随插件释放一起移除） ──────────────────────────────────
    function installStyle() {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-skill-quickpick'
      tag.textContent = CSS.join('\n')
      document.head.appendChild(tag)
      return () => { try { tag.remove() } catch (e) { /* 已移除 */ } }
    }

    // ── 技能目录：按会话 single-flight 缓存 ──────────────────────────────
    const catalogs = new Map()

    function clearCatalog(sessionId) {
      const entry = catalogs.get(sessionId)
      if (!entry) return
      catalogs.delete(sessionId)
      try { entry.abort.abort() } catch (e) { /* ignore */ }
    }

    function fetchCatalog(ctx, sessionId) {
      const hit = catalogs.get(sessionId)
      if (hit) return hit.promise
      const abort = new AbortController()
      const promise = (async () => {
        const remote = ctx.remote
        const rpc = remote && remote.skills
        if (!rpc || typeof rpc.list !== 'function') {
          throw new Error('宿主未提供 skills RPC，无法读取技能目录')
        }
        const result = await rpc.list({ sessionId }, abort.signal)
        if (!result || result.ok !== true) {
          const err = result && result.error
          throw new Error(err ? (err.code + ': ' + err.message) : '读取技能目录失败')
        }
        const list = result.value && result.value.skills
        return Array.isArray(list) ? list : []
      })()
      const entry = { promise, abort }
      catalogs.set(sessionId, entry)
      promise.catch(() => {
        if (catalogs.get(sessionId) === entry) catalogs.delete(sessionId)
      })
      return promise
    }

    // ── 插入：唯一会改动用户草稿的操作 ──────────────────────────────────
    function makeInserter(actions, readDraft) {
      return (skillName) => {
        const text = '/' + skillName + ' '
        let inserted = false
        try {
          if (actions
            && typeof actions.captureInsertion === 'function'
            && typeof actions.insertText === 'function') {
            inserted = actions.insertText(text, actions.captureInsertion()) === true
          }
        } catch (e) {
          inserted = false
        }
        if (!inserted) {
          // 回退：setDraft 是覆盖语义，必须自己拼上原草稿
          try {
            if (actions && typeof actions.setDraft === 'function') {
              const current = readDraft() || ''
              actions.setDraft(current.trim() ? current + '\n' + text : text)
              inserted = true
            }
          } catch (e) {
            inserted = false
          }
        }
        // 面板一关焦点掉到 body，还回去，让「插入 → 接着写 → 回车」连贯
        try {
          const editor = document.querySelector('[data-composer-card] [contenteditable="true"]')
          if (editor && typeof editor.focus === 'function') editor.focus()
        } catch (e) { /* 纯增强，宿主结构变了就跳过 */ }
        return inserted
      }
    }

    // ── 来源推断（启发式：只用于展示，不参与逻辑） ──────────────────────
    /**
     * 推断技能来源，永远返回四类之一。
     *
     * 关键规则：
     *   - **path 为空 → 内置**。文件系统 provider 给本地技能一定会带上 SKILL.md 的
     *     绝对路径；内置技能打包在 app.asar 里，没有可打开的路径，所以 path 是空的。
     *     实测内置那 8 个就是空 path。
     *   - **`<项目>/.dsh/skills` 与 `<项目>/.agents/skills` → 项目**。这是 DSH 官方
     *     provider 的项目级根（rank 100 / 200）。旧版把它们归进「用户」，于是项目
     *     技能看起来像用户技能、点禁用却 400 —— P2 的诱因之一。
     *   - 判断一律先转小写：Windows 路径大小写不敏感，`Node_Modules` 也得认出来。
     *
     * 局限：这台机器 DSH_HOME 是 `<...>/dsh-home`，所以 `dsh-home/skills` 能判成用户级；
     * 如果 DSH_HOME 被设成 `~/.dsh`，它的路径会命中 `/.dsh/skills/` 被误判成项目。
     * 这只是**分组显示**，不影响操作（操作权限在服务端按真实根判定）。
     */
    function sourceOf(path) {
      const text = typeof path === 'string' ? path : ''
      if (text === '') return '内置'
      const normalized = text.replace(/\\/g, '/').toLowerCase()
      if (normalized.indexOf('node_modules/@deepseek-ai/') >= 0) return '内置'
      if (normalized.indexOf('app.asar') >= 0) return '内置'
      // 用户级：<DSH_HOME>/skills（本机为 .../dsh-home/skills）
      if (normalized.indexOf('/dsh-home/skills/') >= 0) return '用户'
      // 项目级：<projectRoot>/.dsh/skills 或 <projectRoot>/.agents/skills
      if (normalized.indexOf('/.dsh/skills/') >= 0 || normalized.indexOf('/.agents/skills/') >= 0) return '项目'
      // 兜底：其他任何 /skills/ 目录（比如 customSkillDirs 配成 <proj>/skills）
      if (normalized.indexOf('/skills/') >= 0) return '项目'
      return '其他'
    }

    /**
     * 使用统计的悬停详情。
     *
     * 行内只留一个「已用 N 次」，具体拆解放 title 里 —— 三个数字标签挤一行太吵，
     * 但真想知道「模型用过几次、我手动用过几次、最后一次是什么时候」时要有地方看。
     */
    function usageDetailOf(entry, modelCount, manualCount) {
      const lines = []
      if (modelCount > 0) lines.push('模型自主加载 ' + modelCount + ' 次')
      if (manualCount > 0) lines.push('你手动调用 ' + manualCount + ' 次')
      const last = entry && typeof entry.last === 'number' ? entry.last : 0
      if (last > 0) {
        const at = new Date(last)
        const pad = (n) => String(n).padStart(2, '0')
        lines.push('最近使用 ' + (at.getMonth() + 1) + '/' + at.getDate()
          + ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes()))
      }
      lines.push('（统计从插件安装当天开始，此前的不算）')
      return lines.join('\n')
    }

    /**
     * 从草稿里解析已写入的 /技能名。
     *
     * 必须和 DSH 的规则一致：**以空白为界**。之前用了裸的 `/([a-z0-9._-]+)/`，
     * 结果 `/etc/passwd`、`C:/Users/xxx` 里的片段也被当成技能名，导致某些行莫名置灰。
     */
    function insertedNamesOf(draft) {
      const names = new Set()
      if (typeof draft !== 'string' || draft === '') return names
      const pattern = /(^|\s)\/([a-z0-9][a-z0-9._-]*)(?=[\s,，。.!！?？;；:：)）"']|$)/gi
      let match = pattern.exec(draft)
      while (match !== null) {
        names.add(match[2])
        match = pattern.exec(draft)
      }
      return names
    }

    /** 从插槽 props 里尽力拿到当前会话 id。 */
    function sessionIdOf(props) {
      if (!props) return null
      if (typeof props.sessionId === 'string' && props.sessionId !== '') return props.sessionId
      const session = props.session
      if (session) {
        if (typeof session.sessionId === 'string' && session.sessionId !== '') return session.sessionId
        if (typeof session.id === 'string' && session.id !== '') return session.id
      }
      return null
    }

    // ── 触发按钮 ────────────────────────────────────────────────────────
    function makeTrigger(store) {
      return function SkillTrigger() {
        const open = React.useSyncExternalStore(store.subscribe, store.get)
        return React.createElement('button', {
          type: 'button',
          className: open ? 'sqp-trigger active' : 'sqp-trigger',
          title: '技能',
          'aria-label': '技能',
          'aria-expanded': open,
          onClick: (event) => {
            event.preventDefault()
            event.stopPropagation()
            store.toggle()
          },
        }, React.createElement('svg', {
          viewBox: '0 0 24 24',
          width: 18,
          height: 18,
          'aria-hidden': 'true',
          style: { display: 'block' },
        }, React.createElement('path', { d: ICON_PATH, fill: 'currentColor' })))
      }
    }

    // ── 技能面板 ────────────────────────────────────────────────────────
    function makePanel(ctx) {
      return function SkillPanel(props) {
        const h = React.createElement
        const store = props.store
        const actions = props.inputActions
        const open = React.useSyncExternalStore(store.subscribe, store.get)

        // 草稿必须从 useInput 实时读；props.input.draft 不存在
        const useLiveInput = typeof props.useInput === 'function' ? props.useInput : (() => null)
        const inputState = useLiveInput((s) => s)

        const [phase, setPhase] = React.useState('idle') // idle | loading | ready | error
        const [skills, setSkills] = React.useState([])
        const [errorText, setErrorText] = React.useState('')
        const [query, setQuery] = React.useState('')
        const [notice, setNotice] = React.useState({ text: '', warn: false })
        // 服务端翻译表变化时递增，触发重渲染（表本身存在模块级变量里）
        const [zhVersion, setZhVersion] = React.useState(0)
        // 使用统计拉回来后递增，触发重渲染（数据同样在模块级变量里）
        const [usageVersion, setUsageVersion] = React.useState(0)
        /** 排序方式：custom = 拖拽自定义，usage = 按使用次数，name = 按名称。持久化到 localStorage。 */
        const [sortMode, setSortMode] = React.useState(() => {
          try {
            const saved = localStorage.getItem('sqp-sort-mode')
            if (saved === 'custom' || saved === 'usage' || saved === 'name') return saved
          } catch (error) { /* 隐私模式等拿不到 localStorage，用默认值 */ }
          return 'custom'
        })
        /** 拖拽保存的自定义顺序：{ [技能名]: 序号 }；内置技能不在里面 */
        const [customOrder, setCustomOrder] = React.useState({})
        /** 视图：list = 技能列表，trash = 回收站，settings = 设置 */
        const [view, setView] = React.useState('list')
        /**
         * 功能开关（宿主持久化在 skill-quickpick-settings.json）。
         * 默认全部关闭 —— 高风险功能必须由用户显式开启。
         */
        const [settings, setSettings] = React.useState({
          trashEnabled: false,
          disableEnabled: false,
          autoTranslate: false,
          statsEnabled: false,
        })
        const [settingsDraft, setSettingsDraft] = React.useState(null)
        /** 点过引导条上的「不再提示」后递增，触发重渲染把引导条收起来 */
        const [setupBannerVersion, setSetupBannerVersion] = React.useState(0)
        /** 回收站条目 */
        const [trashItems, setTrashItems] = React.useState([])
        /** 回收站保留天数（宿主返回，可在面板里改，最短 1 天） */
        const [retentionDays, setRetentionDays] = React.useState(7)
        /** 保留天数的输入框草稿 */
        const [retentionInput, setRetentionInput] = React.useState('7')
        /**
         * 危险操作的数字确认弹窗：{ title, message, code, input, onConfirm }。
         * 用户必须把 code 原样输进输入框才能点确认，避免手滑。
         */
        const [confirming, setConfirming] = React.useState(null)
        // 正在编辑的技能 { name, zh, desc, note }；null 表示编辑器关闭
        const [editing, setEditing] = React.useState(null)
        const [saving, setSaving] = React.useState(false)
        // 正在切换启用状态的技能名（防连点 + 显示转圈）
        const [toggling, setToggling] = React.useState('')
        // 正在执行「全部恢复」
        const [restoring, setRestoring] = React.useState(false)
        // 正在等宿主的翻译结果（显示旋转圆环）
        const [translating, setTranslating] = React.useState(false)

        const sessionId = sessionIdOf(props)
        const draft = inputState && typeof inputState.draft === 'string' ? inputState.draft : ''

        const readDraft = () => {
          try {
            return (inputState && inputState.draft) || ''
          } catch (e) {
            return ''
          }
        }
        const insert = React.useMemo(
          () => makeInserter(actions, readDraft),
          [actions, inputState],
        )

        // 打开时拉数据
        React.useEffect(() => {
          if (!open) return undefined
          let alive = true
          setPhase('loading')
          setErrorText('')
          ;(async () => {
            try {
              if (sessionId === null) {
                throw new Error('拿不到当前会话 id，无法读取技能目录')
              }
              // 先拿功能开关：后面的统计/回收站/翻译都要按开关决定要不要做
              const fetchSettingsOnce = (async () => {
                // fallback 必须和 state 初始值一样含全部四个字段。少一个字段会导致
                // 「设置没拉到 → 保存时把其余开关写成 false」的静默重置。
                const fallback = {
                  trashEnabled: false,
                  disableEnabled: false,
                  autoTranslate: false,
                  statsEnabled: false,
                }
                try {
                  const response = await fetch('/skill-quickpick/settings', {
                    headers: { accept: 'application/json' },
                    cache: 'no-store',
                  })
                  if (!response.ok) return fallback
                  const body = await response.json()
                  if (!body || body.ok !== true || !body.settings) return fallback
                  const parsed = {
                    trashEnabled: body.settings.trashEnabled === true,

                    disableEnabled: body.settings.disableEnabled === true,
                    autoTranslate: body.settings.autoTranslate === true,
                    statsEnabled: body.settings.statsEnabled === true,
                  }
                  if (alive) {
                    setSettings(parsed)
                    setSettingsDraft(parsed)
                  }
                  return parsed
                } catch (error) {
                  return fallback
                }
              })()
              // 每次打开面板都重新拉目录：新增 / 删除 / 卸载技能后不用重启就能看到
              clearCatalog(sessionId)
              const list = await fetchCatalog(ctx, sessionId)
              if (!alive) return
              // 诊断（只打一次，避免每开一次面板刷屏）：确认过 skills.list 只对本地
              // 文件技能回传 path，内置/运行时技能一律没有 —— 分组就是按这个区分的。
              if (!catalogLogged) {
                catalogLogged = true
                try {
                  console.log('[skill-quickpick] 技能目录原始对象：')
                  for (const item of list) {
                    console.log('  -', JSON.stringify(item))
                  }
                } catch (logError) { /* 纯诊断，失败无影响 */ }
              }
              setSkills(list)
              setPhase('ready')
              // 翻译：每次打开都拉（技能列表随会话/preset 变化，缓存会漏掉新出现的技能）。
              // 圆环延迟 250ms 才出现：全部命中缓存时请求很快，不该闪一下圆环。
              let translateTimer = setTimeout(() => {
                if (alive) setTranslating(true)
              }, 250)
              fetchRemoteZh(list).then((map) => {
                clearTimeout(translateTimer)
                translateTimer = null
                if (!alive) return
                remoteZh = map
                setZhVersion((value) => value + 1)
                setTranslating(false)
                if (lastTranslatedCount > 0) {
                  const done = lastTranslatedCount
                  setNotice({ text: '已补全 ' + done + ' 个技能的中文', warn: false })
                  setTimeout(() => {
                    setNotice((prev) => (prev.text.indexOf('已补全') === 0 ? { text: '', warn: false } : prev))
                  }, 3500)
                }
              })
              // 使用统计 / 回收站：各自按开关决定要不要拉（关闭时宿主也不做，两边都省）
              fetchSettingsOnce.then((current) => {
                if (!alive) return
                if (current.statsEnabled) {
                  fetchUsage().then((usage) => {
                    if (!alive) return
                    remoteUsage = usage
                    setUsageVersion((value) => value + 1)
                  })
                }
                if (current.trashEnabled) {
                  fetch('/skill-quickpick/trash', {
                    headers: { accept: 'application/json' },
                    cache: 'no-store',
                  })
                    .then((response) => (response.ok ? response.json() : null))
                    .then((data) => {
                      if (!alive) return
                      if (data && data.ok === true && Array.isArray(data.items)) setTrashItems(data.items)
                    })
                    .catch(() => {})
                }
              })
              // 自定义排序：与开关无关，总是拉
              refreshOrder()
            } catch (error) {
              if (!alive) return
              setErrorText(error && error.message ? error.message : String(error))
              setPhase('error')
            }
          })()
          return () => { alive = false }
        }, [open, sessionId])

        // 点外部收起
        React.useEffect(() => {
          if (!open) return undefined
          const onPointerDown = (event) => {
            const target = event && event.target
            if (target && target.closest
              && !target.closest('.sqp-panel')
              && !target.closest('.sqp-trigger')) {
              store.set(false)
            }
          }
          document.addEventListener('pointerdown', onPointerDown)
          return () => document.removeEventListener('pointerdown', onPointerDown)
        }, [open])

        if (!open) return null

        const inserted = insertedNamesOf(draft)
        const normalizedQuery = query.trim().toLowerCase()
        const filtered = skills.filter((skill) => {
          if (normalizedQuery === '') return true
          const rawName = String(skill && skill.name || '')
          const name = rawName.toLowerCase()
          const desc = String(skill && skill.description || '').toLowerCase()
          const zh = zhLookup(rawName, remoteZh)
          if (name.indexOf(normalizedQuery) >= 0 || desc.indexOf(normalizedQuery) >= 0) return true
          if (zh === null) return false
          return zh.name.toLowerCase().indexOf(normalizedQuery) >= 0
            || zh.desc.toLowerCase().indexOf(normalizedQuery) >= 0
        })

        // 排序：custom = 拖拽自定义顺序（内置组固定不动），usage = 用过的排前面，name = 按名称
        const rows = filtered.slice()
        const compareName = (a, b) => String(a && a.name || '').localeCompare(String(b && b.name || ''))
        const orderIndexOf = (skill) => {
          const name = String(skill && skill.name || '')
          return Object.prototype.hasOwnProperty.call(customOrder, name) ? customOrder[name] : Number.MAX_SAFE_INTEGER
        }
        if (sortMode === 'custom') {
          rows.sort((a, b) => {
            const diff = orderIndexOf(a) - orderIndexOf(b)
            return diff !== 0 ? diff : compareName(a, b)
          })
        } else if (sortMode === 'usage') {
          const weightOf = (skill) => {
            const entry = remoteUsage && remoteUsage.calls
              ? remoteUsage.calls[String(skill && skill.name || '')] : null
            if (!entry) return 0
            return (typeof entry.model === 'number' ? entry.model : 0)
              + (typeof entry.manual === 'number' ? entry.manual : 0)
          }
          rows.sort((a, b) => {
            const diff = weightOf(b) - weightOf(a)
            return diff !== 0 ? diff : compareName(a, b)
          })
        } else {
          rows.sort(compareName)
        }

        /**
         * 某一行是否允许拖动。
         *
         * 内置组现在也允许**组内**排序：排序只是插件自己 JSON 里记「显示顺序」，
         * 完全不碰技能文件，没有理由锁死（而内置恰恰是最常用的那批）。
         * 跨组移动仍然禁止 —— 分组是从 path 推断的，跨组拖会让「来源」这个语义说谎。
         */
        const canDrag = () => true

        /** 拖拽放下：只在同一来源组内调整顺序，然后把新的全局序号整体存到宿主。 */
        const onDropRow = (targetSkill) => (event) => {
          event.preventDefault()
          const draggedName = String(event.dataTransfer.getData('text/plain') || '')
          const dragged = rows.find((item) => String(item && item.name || '') === draggedName)
          const targetName = String(targetSkill && targetSkill.name || '')
          if (!dragged || targetName === '' || draggedName === targetName) return
          // 组内限制：内置 / 用户 / 项目 / 其他 之间不能互相移动
          if (sourceOf(dragged.path) !== sourceOf(targetSkill.path)) {
            setNotice({ text: '只能在同一个分组里拖动（跨组移动会打乱「来源」的含义）', warn: true })
            return
          }
          const next = [...rows]
          const from = next.findIndex((item) => String(item && item.name || '') === draggedName)
          const to = next.findIndex((item) => String(item && item.name || '') === targetName)
          if (from < 0 || to < 0) return
          const [moved] = next.splice(from, 1)
          next.splice(to, 0, moved)
          // 记下所有技能的顺序（内置现在也参与组内排序）
          const order = {}
          let seq = 0
          for (const item of next) {
            order[String(item && item.name || '')] = seq++
          }
          setCustomOrder(order)
          setSortMode('custom')
          saveOrder(order)
        }

        const pick = (skill) => {
          const name = skill && skill.name
          if (typeof name !== 'string' || name === '') return
          if (inserted.has(name)) {
            setNotice({ text: '「' + name + '」已经在输入框里了', warn: true })
            return
          }
          // 早期这里还有一条「仅限用户显式调用，仍可插入」的提示，但插入后立刻关面板，
          // 用户根本没机会看到 —— 而且行内本来就有「仅用户」标签，删掉这条死文案。
          const ok = insert(name)
          if (!ok) {
            setNotice({ text: '插入失败：输入框可能正被占用，请手动输入 /' + name, warn: true })
            return
          }
          store.set(false)
        }

        /** 切换禁用状态：调宿主改写 SKILL.md，然后重新拉技能目录。 */
        const doToggle = async (skill, currentlyDisabled) => {
          if (toggling !== '') return
          const name = String(skill && skill.name || '')
          const skillPath = String(skill && skill.path || '')
          setToggling(name)
          const result = await toggleSkill(name, skillPath, !currentlyDisabled)
          setToggling('')
          if (!result.ok) {
            setNotice({ text: '操作失败：' + result.error, warn: true })
            return
          }
          setNotice({
            text: currentlyDisabled
              ? '已启用「' + name + '」，模型下次就能看到它'
              : '已禁用「' + name + '」，模型目录不再包含它',
            warn: false,
          })
          if (sessionId !== null) clearCatalog(sessionId)
          invalidateRemoteZh()
          try {
            const fresh = await fetchCatalog(ctx, sessionId)
            setSkills(fresh)
            remoteZh = await fetchRemoteZh(fresh)
          } catch (error) {
            /* 拉取失败就保留旧列表，下次打开面板会刷新 */
          }
          setZhVersion((value) => value + 1)
        }

        /** 一次性解开所有禁用锁（停用 / 卸载插件前先点它）。 */
        const restoreAll = async () => {
          if (restoring) return
          setRestoring(true)
          try {
            const response = await fetch('/skill-quickpick/restore-all', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            })
            const body = await response.json().catch(() => null)
            if (body && Array.isArray(body.restored)) {
              const failed = Array.isArray(body.failed) ? body.failed : []
              setNotice({
                text: failed.length === 0
                  ? '已恢复 ' + body.restored.length + ' 个技能，锁都解开了'
                  : '恢复了 ' + body.restored.length + ' 个，失败 ' + failed.length + ' 个：'
                    + failed.map((item) => item.name).join(', '),
                warn: failed.length > 0,
              })
            } else {
              setNotice({ text: '恢复失败：宿主没有返回结果', warn: true })
            }
          } catch (error) {
            setNotice({ text: '恢复失败：' + String(error && error.message || error), warn: true })
          }
          // 刷新目录与禁用状态
          if (sessionId !== null) clearCatalog(sessionId)
          invalidateRemoteZh()
          try {
            const fresh = await fetchCatalog(ctx, sessionId)
            setSkills(fresh)
            remoteZh = await fetchRemoteZh(fresh)
          } catch (error) { /* 保留旧列表，下次打开会刷新 */ }
          setZhVersion((value) => value + 1)
          setRestoring(false)
        }

        // ── 卸载 / 回收站 ────────────────────────────────────────────────
        /**
         * 危险操作确认：生成一个 4 位数字，要求用户原样输入才能继续。
         * 比 window.confirm 多一道「真的读了一遍」的门槛。
         */
        const askConfirm = (title, message, onConfirm) => {
          const code = String(Math.floor(1000 + Math.random() * 9000))
          setConfirming({ title, message, code, input: '', onConfirm })
        }

        /** 拉设置（失败就保持默认全关）。 */
        const refreshSettings = async () => {
          try {
            const response = await fetch('/skill-quickpick/settings', {
              headers: { accept: 'application/json' },
              cache: 'no-store',
            })
            if (!response.ok) return
            const body = await response.json()
            if (!body || body.ok !== true || !body.settings) return
            const next = {
              trashEnabled: body.settings.trashEnabled === true,

              disableEnabled: body.settings.disableEnabled === true,
              autoTranslate: body.settings.autoTranslate === true,
              statsEnabled: body.settings.statsEnabled === true,
            }
            setSettings(next)
            setSettingsDraft(next)
          } catch (error) { /* 忽略 */ }
        }

        /** 拉自定义排序。 */
        const refreshOrder = async () => {
          try {
            const response = await fetch('/skill-quickpick/order', {
              headers: { accept: 'application/json' },
              cache: 'no-store',
            })
            if (!response.ok) return
            const body = await response.json()
            if (!body || body.ok !== true || !body.order) return
            const next = {}
            for (const key of Object.keys(body.order)) {
              if (Number.isFinite(body.order[key])) next[key] = body.order[key]
            }
            setCustomOrder(next)
          } catch (error) { /* 忽略 */ }
        }

        /** 保存自定义排序（拖完一次性整体提交）。 */
        const saveOrder = async (order) => {
          try {
            await fetch('/skill-quickpick/order', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ order }),
            })
          } catch (error) {
            setNotice({ text: '保存排序失败：' + String(error && error.message || error), warn: true })
          }
        }

        /** 保存设置（三个布尔值整体提交）。 */
        const saveSettings = async () => {
          if (settingsDraft === null) return
          try {
            const response = await fetch('/skill-quickpick/settings', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              // 用「已保存值 + 草稿」合并后再提交：即使 draft 因为某种原因缺字段，
              // 也不会把用户已经开着的开关静默写成 false。
              body: JSON.stringify({ ...settings, ...(settingsDraft || {}) }),
            })
            const body = await response.json().catch(() => null)
            if (!response.ok || !body || body.ok !== true) {
              setNotice({ text: '保存设置失败：' + ((body && body.error) || ('HTTP ' + response.status)), warn: true })
              return
            }
            const next = {
              trashEnabled: body.settings.trashEnabled === true,

              disableEnabled: body.settings.disableEnabled === true,
              autoTranslate: body.settings.autoTranslate === true,
              statsEnabled: body.settings.statsEnabled === true,
            }
            setSettings(next)
            setSettingsDraft(next)
            setNotice({ text: '设置已保存，立即生效。', warn: false })
          } catch (error) {
            setNotice({ text: '保存设置失败：' + String(error && error.message || error), warn: true })
          }
        }

        /** 拉回收站列表（宿主会顺手清理过期项）。 */
        const refreshTrash = async () => {
          if (!settings.trashEnabled) {
            setTrashItems([])
            return
          }
          try {
            const response = await fetch('/skill-quickpick/trash', {
              headers: { accept: 'application/json' },
              cache: 'no-store',
            })
            if (!response.ok) return
            const body = await response.json()
            if (!body || body.ok !== true) return
            if (Array.isArray(body.items)) setTrashItems(body.items)
            if (typeof body.retentionDays === 'number' && body.retentionDays >= 1) {
              setRetentionDays(body.retentionDays)
              setRetentionInput(String(body.retentionDays))
            }
          } catch (error) { /* 忽略 */ }
        }

        /** 真正提交保留期。 */
        const submitRetention = async (days) => {
          try {
            const response = await fetch('/skill-quickpick/trash', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'set-retention', days }),
            })
            const body = await response.json().catch(() => null)
            if (!response.ok || !body || body.ok !== true) {
              setNotice({ text: '保存失败：' + ((body && body.error) || ('HTTP ' + response.status)), warn: true })
              return
            }
            const saved = typeof body.retentionDays === 'number' ? body.retentionDays : days
            setRetentionDays(saved)
            setRetentionInput(String(saved))
            setNotice({ text: '保留期已设为 ' + saved + ' 天，所有条目的计时从现在重新开始', warn: false })
            await refreshTrash()
          } catch (error) {
            setNotice({ text: '保存失败：' + String(error && error.message || error), warn: true })
          }
        }

        /**
         * 保存保留天数（1 ~ 360 天）。
         *
         * **不需要二次确认**：宿主在改保留期时会重置所有条目的计时起点
         * （`retentionFrom = now`），所以把天数改小不会让任何一项立刻过期 ——
         * 「改设置 → 立即删东西」这条后门在数据层就不存在了。
         */
        const saveRetention = async () => {
          const days = Math.floor(Number(retentionInput))
          if (!Number.isFinite(days) || days < 1) {
            setNotice({ text: '保留天数最少 1 天', warn: true })
            return
          }
          if (days > 360) {
            setNotice({ text: '保留天数最多 360 天', warn: true })
            return
          }
          await submitRetention(days)
        }

        /** 技能目录变了之后重新加载（卸载 / 恢复后调用）。 */
        const reloadSkills = async () => {
          if (sessionId === null) return
          clearCatalog(sessionId)
          invalidateRemoteZh()
          try {
            const fresh = await fetchCatalog(ctx, sessionId)
            setSkills(fresh)
            remoteZh = await fetchRemoteZh(fresh)
          } catch (error) { /* 保留旧列表 */ }
          setZhVersion((value) => value + 1)
        }

        /** 卸载 = 把技能目录移进回收站（需要输入数字确认）。 */
        const doUninstall = (skill) => {
          const name = String(skill && skill.name || '')
          const skillPath = String(skill && skill.path || '')
          if (name === '' || skillPath === '') {
            setNotice({ text: '只能卸载本地技能（内置技能没有可写的目录）', warn: true })
            return
          }
          askConfirm(
            '卸载技能「' + name + '」',
            '技能目录会移到回收站，模型下次就看不到它了（之后可以恢复）。',
            async () => {
              try {
                const response = await fetch('/skill-quickpick/trash', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ action: 'remove', name, path: skillPath }),
                })
                const body = await response.json().catch(() => null)
                if (!response.ok || !body || body.ok !== true) {
                  setNotice({ text: '卸载失败：' + ((body && body.error) || ('HTTP ' + response.status)), warn: true })
                  return
                }
                setEditing(null)
                setNotice({ text: '已把「' + name + '」移到回收站', warn: false })
                await reloadSkills()
                await refreshTrash()
              } catch (error) {
                setNotice({ text: '卸载失败：' + String(error && error.message || error), warn: true })
              }
            },
          )
        }

        /**
         * 回收站里只做一件事：恢复。
         *
         * 这里**故意没有「永久删除」按钮** —— 回收站是冷静期，只按保留期自动清理。
         * 否则「卸载 → 马上清空回收站」两步就把安全网绕没了，防上头就没意义了。
         */
        const doTrashAction = async (action, item) => {
          if (!item || typeof item.id !== 'string') return
          if (action !== 'restore') return
          try {
            const response = await fetch('/skill-quickpick/trash', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'restore', id: item.id }),
            })
            const body = await response.json().catch(() => null)
            if (!response.ok || !body || body.ok !== true) {
              setNotice({ text: '恢复失败：' + ((body && body.error) || ('HTTP ' + response.status)), warn: true })
              return
            }
            setNotice({ text: '已恢复「' + item.name + '」', warn: false })
            await refreshTrash()
            await reloadSkills()
          } catch (error) {
            setNotice({ text: '恢复失败：' + String(error && error.message || error), warn: true })
          }
        }

        /** 回收站里某一项还剩几天（跟随当前保留期设置）。 */
        const trashDaysLeftOf = (item) => {
          const total = Math.max(1, retentionDays) * 24 * 60 * 60 * 1000
          const elapsed = Date.now() - (typeof item.deletedAt === 'number' ? item.deletedAt : Date.now())
          return Math.max(0, Math.ceil((total - elapsed) / (24 * 60 * 60 * 1000)))
        }
        /** 有没有 ≤1 天就过期的项 —— 有的话垃圾桶按钮变红提醒 */
        const hasUrgentTrash = trashItems.some((item) => trashDaysLeftOf(item) <= 1)

        const head = h('div', { className: 'sqp-head' },
          h('input', {
            type: 'text',
            className: 'sqp-search',
            value: query,
            placeholder: '搜索技能名或描述…',
            'aria-label': '搜索技能',
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                store.set(false)
              }
            },
          }),
          // 排序只在技能列表里有意义；回收站是一份清单，排序按钮放在那里没作用，直接不显示
          (view !== 'list') ? null : h('button', {
            type: 'button',
            className: 'sqp-sort',
            title: sortMode === 'custom'
              ? '当前：拖拽自定义顺序（拖动行可调整）。点击改为按使用频率。'
              : sortMode === 'usage'
                ? '当前：按使用频率排序。点击改为按名称。'
                : '当前：按名称排序。点击改为拖拽自定义顺序。',
            onClick: () => {
              const next = sortMode === 'custom' ? 'usage' : sortMode === 'usage' ? 'name' : 'custom'
              // 统计关闭时「按使用频率」权重全是 0，排出来跟按名称一样 —— 不给用户一个点了没反应的按钮
              if (next === 'usage' && !settings.statsEnabled) {
                setNotice({ text: '使用统计已关闭，无法按使用频率排序。可在 ⚙ 设置里开启。', warn: true })
                setSortMode('name')
                try { localStorage.setItem('sqp-sort-mode', 'name') } catch (error) { /* 忽略 */ }
                return
              }
              setSortMode(next)
              try { localStorage.setItem('sqp-sort-mode', next) } catch (error) { /* 忽略 */ }
            },
          }, sortMode === 'custom' ? '⇅ 自定义' : sortMode === 'usage' ? '⇅ 使用' : '⇅ 名称'),
          // 回收站按钮只在「卸载/回收站」开关打开时出现
          settings.trashEnabled ? h('button', {
            type: 'button',
            className: (view === 'trash' ? 'sqp-sort sqp-sort-on' : 'sqp-sort')
              + (hasUrgentTrash ? ' sqp-trash-urgent' : ''),
            title: hasUrgentTrash
              ? '回收站里有技能快过期了（≤1 天），点进去看看'
              : '回收站：已卸载的技能。只能恢复，不能手动删除，到期自动清理。',
            onClick: () => {
              const next = view === 'trash' ? 'list' : 'trash'
              setView(next)
              if (next === 'trash') refreshTrash()
              if (next === 'trash') refreshSettings()
            },
          }, '🗑 ' + String(trashItems.length)) : null,
          // 设置入口（齿轮）
          h('button', {
            type: 'button',
            className: view === 'settings' ? 'sqp-sort sqp-sort-on' : 'sqp-sort',
            title: '功能开关：禁用技能、卸载/回收站、自动翻译、使用统计（默认全部关闭）',
            onClick: () => {
              const next = view === 'settings' ? 'list' : 'settings'
              setView(next)
              if (next === 'settings') refreshSettings()
            },
          }, '⚙'),
          remoteDisabled.size > 0 ? h('button', {
            type: 'button',
            className: 'sqp-restore-all',
            title: '把所有被禁用的技能恢复（解开锁）。停用或卸载插件前建议先点一下。',
            disabled: restoring,
            onClick: restoreAll,
          }, restoring ? '恢复中…' : '↺ ' + remoteDisabled.size) : null,
          h('span', { className: 'sqp-count' },
            view === 'trash'
              ? String(trashItems.length) + ' 项'
              : String(rows.length) + ' / ' + String(skills.length)),
        )

        let body
        if (view === 'settings') {
          // 功能开关：三个高风险功能默认关闭，由用户显式开启
          const draft = settingsDraft || settings
          const toggleRow = (key, label, hint) => h('label', { className: 'sqp-setting-row' },
            h('input', {
              type: 'checkbox',
              checked: draft[key] === true,
              onChange: (event) => {
                setSettingsDraft({ ...draft, [key]: event.target.checked })
              },
            }),
            h('span', { className: 'sqp-setting-text' },
              h('strong', null, label),
              h('span', { className: 'sqp-setting-hint' }, hint),
            ),
          )
          body = h('div', { className: 'sqp-settings-view' },
            toggleRow('disableEnabled', '禁用 / 启用技能',
              '改写 SKILL.md 的 disable-model-invocation，让模型看不到这个技能。这是最危险的写操作：插件一旦被停用或卸载，这些锁就只能手动改文件解开。'),
            toggleRow('trashEnabled', '卸载 / 回收站',
              '把技能目录移进回收站、按保留期自动永久清理（没有手动删除按钮）。开启后插件可以移动 skills 目录下的文件夹。'),
            toggleRow('autoTranslate', '自动翻译技能说明',
              '把技能名和描述发给模型翻译成中文（只发这两个字段，不发正文）。关闭后只显示已有翻译和你自己写的中文。'),
            toggleRow('statsEnabled', '使用统计',
              '读取并解压本机历史会话日志，统计技能被加载的次数（只计数，不保存内容）。关闭后不读会话文件。'),
            h('div', { className: 'sqp-editor-actions' },
              h('button', {
                type: 'button',
                className: 'primary',
                onClick: saveSettings,
              }, '保存'),
              h('button', {
                type: 'button',
                onClick: () => setSettingsDraft({ ...settings }),
              }, '还原'),
            ),
            h('div', { className: 'sqp-setting-note' },
              '开关立即生效：关掉的功能马上停止，重新打开也会马上恢复（后台定时器每次运行都会重新读设置，不用重启）。'),
          )
        } else if (view === 'trash') {
          const settingRow = h('div', { className: 'sqp-trash-setting' },
            h('span', null, '保留'),
            h('input', {
              type: 'number',
              min: 1,
              max: 360,
              value: retentionInput,
              className: 'sqp-retention-input',
              'aria-label': '回收站保留天数',
              onChange: (event) => setRetentionInput(event.target.value.replace(/[^0-9]/g, '')),
              onKeyDown: (event) => { if (event.key === 'Enter') saveRetention() },
            }),
            h('span', null, '天'),
            h('button', { type: 'button', onClick: saveRetention }, '保存'),
            h('span', { className: 'sqp-trash-hint' }, '到期自动清理，不支持手动删除'),
          )
          body = h('div', { className: 'sqp-trash-view' },
            settingRow,
            trashItems.length === 0
              ? h('div', { className: 'sqp-empty' }, '回收站是空的')
              : h('div', { className: 'sqp-scroll' }, trashItems.map((item) => {
                  const left = trashDaysLeftOf(item)
                  const urgent = left <= 1
                  return h('div', {
                    className: 'sqp-row-wrap',
                    key: String(item.id),
                  },
                    h('div', { className: 'sqp-row', style: { cursor: 'default' } },
                      h('span', {
                        className: urgent ? 'sqp-row-dot sqp-dot-danger' : 'sqp-row-dot',
                        'aria-hidden': 'true',
                      }),
                      h('span', { className: 'sqp-row-body' },
                        h('span', { className: 'sqp-name' }, h('code', null, String(item.name || ''))),
                        h('span', { className: urgent ? 'sqp-desc sqp-desc-danger' : 'sqp-desc' },
                          '删除于 ' + new Date(item.deletedAt || Date.now()).toLocaleString('zh-CN')
                          + ' · 还剩 ' + left + ' 天' + (urgent ? '（快过期）' : '')),
                      ),
                    ),
                    h('button', {
                      type: 'button',
                      className: 'sqp-toggle',
                      title: '恢复到原位置',
                      onClick: () => doTrashAction('restore', item),
                    }, '↩'),
                  )
                })),
          )
        } else if (phase === 'loading') {
          body = h('div', { className: 'sqp-empty' }, '正在读取技能目录…')
        } else if (phase === 'error') {
          body = h('div', { className: 'sqp-empty' }, '读取失败：' + errorText)
        } else if (skills.length === 0) {
          body = h('div', { className: 'sqp-empty' }, '当前会话没有可用技能')
        } else if (rows.length === 0) {
          body = h('div', { className: 'sqp-empty' }, '没有匹配「' + query.trim() + '」的技能')
        } else {
          // 按来源分组渲染：用户技能排最前，内置技能排最后。
          // 「内置」是推断出来的分类：没有可写本地文件的都归这里，文件不可改但**显示顺序可以拖**。
          const GROUPS = [
            { key: '用户', label: '我的技能' },
            { key: '项目', label: '项目技能' },
            { key: '内置', label: '内置' },
            { key: '其他', label: '其他' },
          ]
          const renderRow = (skill) => {
            const name = String(skill && skill.name || '')
            const description = String(skill && skill.description || '')
            const zh = zhLookup(name, remoteZh)
            const title = zh ? zh.name : name
            const text = zh && zh.desc ? zh.desc : description
            const note = zh && zh.note ? zh.note : ''
            const edited = !!(zh && zh.source === 'user')
            const source = sourceOf(skill && skill.path)
            const already = inserted.has(name)
            // 使用统计：model = 模型自主加载，manual = 你手动 /技能名 调用
            const usageEntry = remoteUsage && remoteUsage.calls ? remoteUsage.calls[name] : null
            const modelCount = usageEntry && typeof usageEntry.model === 'number' ? usageEntry.model : 0
            const manualCount = usageEntry && typeof usageEntry.manual === 'number' ? usageEntry.manual : 0
            const usageKnown = !!(remoteUsage && remoteUsage.available)
            // 「内置」这里实际含义是「没有可写的本地文件」：可能是 asar 打包的内置技能，
            // 也可能是运行时注册 / 非文件系统来源的技能。它们都无法改 frontmatter，
            // 所以统一不给禁用按钮 —— 保守方向：宁可少给一个开关，也不误改文件。
            const isReadonly = source === '内置'
            const isDisabled = remoteDisabled.has(name)
            const isUserOnly = skill.modelInvocable === false && !isDisabled
            // 禁用/启用开关关着时，整个 ⊘ 按钮不可用（这是最危险的写操作，默认关）。
            // **例外**：已经disabled的行放行 ↺ —— 启用是解锁，降低风险而不是增加风险，
            // 否则关掉开关的人反而解不开已经锁上的技能。
            const canToggle = !isReadonly && !isUserOnly && (settings.disableEnabled || isDisabled)
            // 有搜索筛选时禁止拖拽：落点重建顺序用的是过滤后的列表，
            // 拖动会只给筛选结果编号、其余技能全部丢失自定义位置（静默毁掉整张排序表）。
            const draggable = canDrag(skill) && normalizedQuery === ''
            return h('div', {
              className: (isDisabled ? 'sqp-row-wrap is-disabled' : 'sqp-row-wrap')
                + (draggable ? ' is-draggable' : ''),
              key: name,
              // 拖拽排序：内置组不可拖；只能在同一来源组内互换位置
              draggable,
              onDragStart: (event) => {
                if (!draggable) {
                  event.preventDefault()
                  return
                }
                event.dataTransfer.setData('text/plain', name)
                event.dataTransfer.effectAllowed = 'move'
              },
              onDragOver: (event) => {
                if (!draggable) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              },
              onDrop: draggable ? onDropRow(skill) : undefined,
            },
              h('button', {
                type: 'button',
                // 翻译中且这一行还没有中文 → 名字和描述做呼吸闪烁，提示「这行正在被处理」
                className: translating && zh === null ? 'sqp-row is-pending' : 'sqp-row',
                disabled: already,
                title: (already ? '已在输入框中 · ' : '') + '/' + name
                  + (description !== '' ? '\n' + description : ''),
                onClick: () => pick(skill),
              },
                h('span', { className: 'sqp-row-dot', 'aria-hidden': 'true' }),
                h('span', { className: 'sqp-row-body' },
                  h('span', { className: 'sqp-name' },
                    h('code', null, title),
                    zh ? h('span', { className: 'sqp-orig' }, name) : null,
                    edited ? h('span', { className: 'sqp-tag used' }, '已编辑') : null,
                    isDisabled ? h('span', { className: 'sqp-tag off' }, '已禁用') : null,
                    isUserOnly ? h('span', { className: 'sqp-tag' }, '仅用户') : null,
                    source !== '' ? h('span', { className: 'sqp-tag' }, source) : null,
                    // 使用统计压成一个标签，详情放 title 里悬停看（三个数字标签太吵）
                    usageKnown && (modelCount > 0 || manualCount > 0)
                      ? h('span', {
                          className: 'sqp-tag used',
                          title: usageDetailOf(usageEntry, modelCount, manualCount),
                        }, '已用 ' + (modelCount + manualCount) + ' 次')
                      : usageKnown ? h('span', { className: 'sqp-tag dim', title: '统计从插件安装当天开始，此前的不算' }, '未使用') : null,
                    already ? h('span', { className: 'sqp-tag' }, '已在草稿') : null,
                  ),
                  text !== '' ? h('span', { className: 'sqp-desc' }, text) : null,
                  note !== '' ? h('span', { className: 'sqp-note' }, '我的备注：' + note) : null,
                ),
              ),
              // 开关没开、又不是可解锁的已禁用行 → **整个按钮不渲染**。
              // 灰按钮配任何 title 都是误导：用户点不动，却还在读「点击禁用」。
              // 看不见的按钮不会撒谎。
              canToggle ? h('button', {
                type: 'button',
                className: isDisabled ? 'sqp-toggle on' : 'sqp-toggle',
                title: isDisabled ? '点击重新启用（让模型重新看到它）'
                  : '点击禁用：模型目录不再包含它，但这里仍可看到和插入',
                disabled: toggling === name,
                'aria-label': (isDisabled ? '启用 ' : '禁用 ') + name,
                onClick: (event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  doToggle(skill, isDisabled)
                },
              }, toggling === name ? '…' : (isDisabled ? '↺' : '⊘')) : null,
              h('button', {
                type: 'button',
                className: 'sqp-edit',
                title: '编辑中文名 / 描述 / 我的备注',
                'aria-label': '编辑 ' + name,
                onClick: (event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setEditing({
                    name,
                    zh: zh ? zh.name : '',
                    desc: zh ? zh.desc : '',
                    note,
                  })
                },
              }, '✎'),
            )
          }
          // 分组兜底：凡是不属于已知三类的都归「其他」，绝不因为来源推断不准而丢行
          const KNOWN_KEYS = ['用户', '项目', '内置', '其他']
          const groupOf = (item) => {
            const guessed = sourceOf(item && item.path)
            return KNOWN_KEYS.indexOf(guessed) >= 0 ? guessed : '其他'
          }
          body = h('div', { className: 'sqp-scroll' }, GROUPS.map((group) => {
            const items = rows.filter((item) => groupOf(item) === group.key)
            if (items.length === 0) return null
            return h('div', { className: 'sqp-group', key: group.key },
              h('div', { className: 'sqp-group-title' }, group.label + ' · ' + items.length),
              items.map(renderRow),
            )
          }))
        }

        const commitEdit = async (restore) => {
          if (editing === null || saving) return
          const target = editing.name
          setSaving(true)
          const ok = await saveOverride(restore
            ? { name: target, restore: true }
            : { name: target, zh: editing.zh, desc: editing.desc, note: editing.note })
          setSaving(false)
          if (!ok) {
            setNotice({ text: '保存失败，请稍后重试', warn: true })
            return
          }
          invalidateRemoteZh()
          setEditing(null)
          setNotice({
            text: restore ? '已恢复「' + target + '」的默认显示' : '已保存「' + target + '」的中文信息',
            warn: false,
          })
          const map = await fetchRemoteZh(skills)
          remoteZh = map
          setZhVersion((value) => value + 1)
        }

        const footText = translating
          ? '正在获取中文名与说明…'
          : notice.text !== ''
            ? notice.text
            : view === 'trash'
              ? '点 ↩ 把技能恢复到原位置'
              : '点一项把 /技能名 插入输入框，不会自动发送；鼠标移到某行可编辑中文名 / 描述 / 备注'

        // 当前正在编辑的技能对象（需要它的 path 才能卸载）
        const editingSkill = editing === null
          ? null
          : skills.find((item) => item && item.name === editing.name) || null

        const editor = editing === null ? null : h('div', {
          className: 'sqp-editor-mask',
          onClick: () => { if (!saving) setEditing(null) },
        },
          h('div', {
            className: 'sqp-editor',
            onClick: (event) => event.stopPropagation(),
          },
            h('h4', null, '编辑中文信息', h('code', null, editing.name)),
            h('label', null, '中文名',
              h('input', {
                type: 'text',
                value: editing.zh,
                placeholder: '留空则用机翻 / 原文',
                onChange: (event) => setEditing({ ...editing, zh: event.target.value }),
              })),
            h('label', null, '描述',
              h('textarea', {
                rows: 3,
                value: editing.desc,
                placeholder: '留空则用机翻 / 原文',
                onChange: (event) => setEditing({ ...editing, desc: event.target.value }),
              })),
            h('label', null, '我的备注（追加显示在描述下面）',
              h('textarea', {
                rows: 2,
                value: editing.note,
                placeholder: '例如：先别用这个，等更新',
                onChange: (event) => setEditing({ ...editing, note: event.target.value }),
              })),
            h('div', { className: 'sqp-editor-actions' },
              h('button', {
                type: 'button',
                className: 'primary',
                disabled: saving,
                onClick: () => commitEdit(false),
              }, saving ? '保存中…' : '保存'),
              h('button', {
                type: 'button',
                className: 'sqp-reset-btn',
                disabled: saving,
                onClick: () => commitEdit(true),
              }, '恢复默认'),
              h('button', {
                type: 'button',
                disabled: saving,
                onClick: () => setEditing(null),
              }, '取消'),
              // 卸载按钮只在「卸载/回收站」开关打开时出现，且只对本地技能
              settings.trashEnabled && editingSkill && editingSkill.path
                ? h('button', {
                    type: 'button',
                    className: 'sqp-danger',
                    disabled: saving,
                    title: '把技能目录移到回收站（之后可以在回收站里恢复）',
                    style: { marginLeft: 'auto' },
                    onClick: () => doUninstall(editingSkill),
                  }, '卸载')
                : null,
            ),
          ),
        )

        /**
         * 「四项功能默认关闭」提示条。
         *
         * 三个显示条件缺一不可：
         *   ① settingsDraft 已加载（**不是** settings 初值）—— 否则设置请求返回前，
         *      四项全开的用户也会看到「默认关闭」，那是一句假话；GET 失败时更会常驻假话。
         *   ② 四项确实全关
         *   ③ 当前不在设置页（已经到设置页了，提示条就没用了）
         */
        const allSwitchesOff = settingsDraft !== null
          && !settings.disableEnabled && !settings.trashEnabled
          && !settings.autoTranslate && !settings.statsEnabled
        // 用 **sessionStorage**：点过 ✕ 只在本次运行里隐藏，重启 DSH 后重新出现。
        // 所以按钮文案是「暂时隐藏」而不是「不再提示」——不能承诺做不到的事。
        const SETUP_BANNER_KEY = 'sqp-setup-banner-dismissed-session'
        let setupBannerDismissed = false
        try {
          setupBannerDismissed = sessionStorage.getItem(SETUP_BANNER_KEY) === '1'
        } catch (error) { /* 隐私模式拿不到 sessionStorage，就不记住 */ }
        const dismissSetupBanner = () => {
          try { sessionStorage.setItem(SETUP_BANNER_KEY, '1') } catch (error) { /* 忽略 */ }
          setSetupBannerVersion((value) => value + 1)
        }
        const openSettingsFromBanner = () => {
          setView('settings')
          refreshSettings()
        }
        // 在设置页里不显示（已经到目的地了，提示条没意义）；
        // 有禁用记录时也不显示 —— 那条黄色警告更重要，两条一起出现会挤爆面板。
        const setupBanner = (allSwitchesOff && !setupBannerDismissed
          && view !== 'settings' && remoteDisabled.size === 0) ? h('div', {
          className: 'sqp-setup-bubble',
          role: 'button',
          tabIndex: 0,
          title: '点这里去设置里开启',
          onClick: openSettingsFromBanner,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              openSettingsFromBanner()
            }
          },
        },
          h('span', { className: 'sqp-setup-text' },
            '4 项功能默认关闭：',
            h('span', { className: 'sqp-setup-items' }, '禁用技能 · 卸载回收站 · 自动翻译 · 使用统计'),
            '　去 ',
            h('span', { className: 'sqp-setup-gear', 'aria-hidden': 'true' }, '⚙'),
            ' 更改'),
          h('button', {
            type: 'button',
            className: 'sqp-setup-dismiss',
            title: '暂时隐藏（重启后重新出现）',
            'aria-label': '暂时隐藏',
            onClick: (event) => {
              // 阻止冒泡：否则点 ✕ 会连带触发气泡本身的「打开设置」
              event.stopPropagation()
              dismissSetupBanner()
            },
            onKeyDown: (event) => {
              // 键盘路径同样要拦：焦点在 ✕ 上按 Enter/Space 时，外层 role=button 的
              // onKeyDown 会接住并 preventDefault，把按钮自己的默认激活一并取消 ——
              // 结果是「跳到设置页，提示条没关掉」，正好反了。
              event.stopPropagation()
            },
          }, '✕'),
        ) : null

        const warnBanner = remoteDisabled.size > 0 ? h('div', { className: 'sqp-warn-banner' },
          h('span', null, '⚠ ' + remoteDisabled.size
            + ' 个技能处于禁用状态。停用或卸载本插件前请先恢复——插件停掉之后就没有界面能解锁了。'),
          h('button', {
            type: 'button',
            disabled: restoring,
            onClick: restoreAll,
          }, restoring ? '恢复中…' : '全部恢复'),
        ) : null

        // 危险操作的数字确认弹窗
        const confirmDialog = confirming === null ? null : h('div', {
          className: 'sqp-confirm-mask',
          onClick: () => setConfirming(null),
        },
          h('div', {
            className: 'sqp-editor sqp-editor-wide',
            onClick: (event) => event.stopPropagation(),
          },
            h('h4', null, confirming.title),
            h('p', { className: 'sqp-confirm-msg' }, confirming.message),
            h('div', { className: 'sqp-confirm-label' }, '请输入下面的数字以确认：'),
            h('div', { className: 'sqp-confirm-code' }, confirming.code.split('').join(' ')),
            h('input', {
              type: 'text',
              inputMode: 'numeric',
              className: 'sqp-confirm-input',
              value: confirming.input,
              placeholder: '在这里输入数字',
              autoFocus: true,
              onChange: (event) => setConfirming({ ...confirming, input: event.target.value.replace(/\s/g, '') }),
              onKeyDown: (event) => {
                if (event.key === 'Escape') { setConfirming(null); return }
                if (event.key === 'Enter' && confirming.input === confirming.code) {
                  const action = confirming.onConfirm
                  setConfirming(null)
                  action()
                }
              },
            }),
            h('div', { className: 'sqp-editor-actions' },
              h('button', { type: 'button', onClick: () => setConfirming(null) }, '取消'),
              h('button', {
                type: 'button',
                className: 'sqp-danger',
                disabled: confirming.input !== confirming.code,
                onClick: () => {
                  const action = confirming.onConfirm
                  setConfirming(null)
                  action()
                },
              }, '确认'),
            ),
          ),
        )

        return h('div', { className: 'sqp-panel', role: 'dialog', 'aria-label': '技能' },
          head,
          setupBanner,
          warnBanner,
          body,
          h('div', {
            className: notice.warn ? 'sqp-foot warn' : 'sqp-foot',
          },
            // 用 SVG 画圆环：半径大、描边细、圆头收口 —— 比 CSS border 画的小环圆润得多
            translating ? h('svg', {
              className: 'sqp-ring',
              viewBox: '0 0 12 12',
              width: 12,
              height: 12,
              'aria-hidden': 'true',
            }, h('circle', {
              cx: 6,
              cy: 6,
              r: 4.4,
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.3,
              strokeLinecap: 'round',
              strokeDasharray: '20 8',
            })) : null,
            footText,
          ),
          editor,
          confirmDialog,
        )
      }
    }

    // ── 插件主体 ────────────────────────────────────────────────────────
    function apply(ctx) {
      ctx.effect(() => installStyle(), 'skill-quickpick: style')

      const store = makeStore(false)
      const Trigger = makeTrigger(store)
      const Panel = makePanel(ctx)

      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'skill-quickpick',
        order: 6,
        label: '技能',
      }, () => React.createElement(Trigger)))

      ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay',
        id: 'skill-quickpick',
        order: 6,
        label: '技能',
      }, (props) => React.createElement(Panel, { ...props, store })))

      // 目录会随预设切换 / 插件变化失效
      if (ctx.remote && typeof ctx.remote.$on === 'function') {
        ctx.remote.$on('agent-preset/selected', () => { for (const id of Array.from(catalogs.keys())) clearCatalog(id) })
        ctx.remote.$on('plugin-manager/changed', () => { for (const id of Array.from(catalogs.keys())) clearCatalog(id) })
      }
      if (typeof ctx.on === 'function') {
        ctx.on('connection/reset', () => { for (const id of Array.from(catalogs.keys())) clearCatalog(id) })
      }
    }

    exports.apply = apply
    exports.inject = ['slots', 'remote', 'remote.skills']
    return module.exports
  },
})
