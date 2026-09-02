/**
 * dsh-fs-allowlist — 浏览器端。
 *
 * 手写 __ModuleLoader__ bundle（无构建步骤）：在 设置 → 插件 里注册「目录白名单」页签，
 * 可视化管理 write/edit 与 bash 共用的免审批白名单目录，并可开关 bash 升权代答。
 * 数据源：服务端 /api/fs-allowlist/state（GET）与 /api/fs-allowlist/update（POST），
 * 服务端落盘 $DSH_HOME/fs-allowlist.json 并热更新运行态，改动即时生效、无需重启。
 */
window.__ModuleLoader__.load({
	id: "dsh-fs-allowlist",
	factory: (require) => {
		const module = { exports: {} };
		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const h = jsxRuntime.jsx;
		const hs = jsxRuntime.jsxs;
		const Fragment = jsxRuntime.Fragment;
		const { useCallback, useEffect, useState } = react;

		//#region css
		const css = [
			".fsal_wrap{display:flex;flex-direction:column;gap:12px;max-width:720px;padding:4px 0 16px;color:var(--dsw-alias-label-primary)}",
			".fsal_card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-fill-l1,transparent)}",
			".fsal_title{font-size:13px;font-weight:600;line-height:20px}",
			".fsal_hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}",
			".fsal_row{display:flex;align-items:center;gap:8px}",
			".fsal_path{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".fsal_input{flex:1;font:inherit;font-size:12px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary)}",
			".fsal_input:focus{outline:1px solid var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}",
			".fsal_btn{cursor:pointer;font:inherit;font-size:12px;padding:4px 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-l1,transparent);color:var(--dsw-alias-label-primary)}",
			".fsal_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".fsal_btn:disabled{opacity:.5;cursor:default}",
			".fsal_btnDanger{color:var(--dsw-alias-state-error-primary)}",
			".fsal_switch{cursor:pointer;border:0;border-radius:10px;width:36px;height:20px;padding:2px;background:var(--dsw-alias-border-l3);position:relative;flex:none}",
			".fsal_switch[data-on]{background:var(--dsw-alias-brand-primary)}",
			".fsal_thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s}",
			".fsal_switch[data-on] .fsal_thumb{transform:translateX(16px)}",
			".fsal_toggleRow{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}",
			".fsal_toggleText{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
			".fsal_msg{font-size:12px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-fill-l2,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary)}",
			".fsal_err{color:var(--dsw-alias-state-error-primary)}",
			".fsal_empty{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:4px 0}"
		].join("");
		//#endregion

		let styleInjected = false;
		function ensureStyle() {
			if (styleInjected || typeof document === "undefined") return;
			styleInjected = true;
			const tag = document.createElement("style");
			tag.setAttribute("data-dsh-fs-allowlist", "");
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		async function api(path, opts) {
			const res = await fetch(path, opts);
			let data = {};
			try { data = await res.json(); } catch { data = {}; }
			if (!res.ok || data.ok === false) throw new Error(data.message || data.error || `HTTP ${res.status}`);
			return data;
		}
		const loadState = () => api("/api/fs-allowlist/state");
		const postUpdate = (body) => api("/api/fs-allowlist/update", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body)
		});

		function AllowlistTab() {
			const [state, setState] = useState(null);
			const [draft, setDraft] = useState("");
			const [message, setMessage] = useState(null); // {text, error}
			const [busy, setBusy] = useState(false);

			const refresh = useCallback(async () => {
				try {
					const data = await loadState();
					setState(data.state);
				} catch (e) {
					setMessage({ text: `加载失败：${e instanceof Error ? e.message : String(e)}`, error: true });
				}
			}, []);

			useEffect(() => { ensureStyle(); refresh(); }, [refresh]);

			const update = useCallback(async (body, okText) => {
				setBusy(true);
				try {
					const data = await postUpdate(body);
					setState(data.state);
					setMessage(okText ? { text: okText } : null);
				} catch (e) {
					setMessage({ text: e instanceof Error ? e.message : String(e), error: true });
				} finally {
					setBusy(false);
				}
			}, []);

			const addRoot = useCallback(() => {
				const root = draft.trim();
				if (root === "") return;
				// 跨平台绝对路径：POSIX（/ 开头）或 Windows 盘符（C:\ / C:/）
				const isAbs = root.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(root);
				if (!isAbs) {
					setMessage({ text: "需要绝对路径：macOS/Linux 如 /Users/xxx/目录，Windows 如 D:\\projects\\目录", error: true });
					return;
				}
				setDraft("");
				update({ action: "add", root }, `已添加并即时生效：${root}`);
			}, [draft, update]);

			const removeRoot = useCallback((root) => {
				update({ action: "remove", root }, `已移除：${root}`);
			}, [update]);

			const toggleBash = useCallback(() => {
				const next = !(state?.bashAutoApprove ?? true);
				update({ action: "setBashAutoApprove", value: next }, next ? "bash 升权代答已开启" : "bash 升权代答已关闭");
			}, [state, update]);

			const roots = Array.isArray(state?.roots) ? state.roots : [];
			const bashOn = state?.bashAutoApprove ?? true;

			return hs("div", { className: "fsal_wrap", children: [
				h("div", { className: "fsal_hint", children: "白名单目录内的文件对 write/edit 工具免审批直接读写；bash 命中白名单路径的升权请求可自动放行（可开关）。改动即时生效，无需重启 DSH。" }),

				hs("div", { className: "fsal_card", children: [
					hs("div", { className: "fsal_row", children: [
						h("span", { className: "fsal_title", children: "白名单目录" }),
						h("span", { style: { flex: 1 } }),
						h("button", { className: "fsal_btn", disabled: busy, onClick: () => refresh(), children: "刷新" })
					] }),
					roots.length === 0
						? h("div", { className: "fsal_empty", children: "暂无目录。添加后，这些目录内的写入将不再弹审批。" })
						: roots.map((root) => hs("div", { className: "fsal_row", key: root, children: [
							h("span", { className: "fsal_path", title: root, children: root }),
							h("button", {
								className: "fsal_btn fsal_btnDanger",
								disabled: busy,
								onClick: () => removeRoot(root),
								children: "移除"
							})
						] })),
					hs("div", { className: "fsal_row", children: [
						h("input", {
							className: "fsal_input",
							placeholder: "输入绝对路径，如 /Users/xxx/目录 或 D:\\projects\\目录",
							value: draft,
							spellCheck: false,
							onChange: (e) => setDraft(e.target.value),
							onKeyDown: (e) => { if (e.key === "Enter") addRoot(); }
						}),
						h("button", { className: "fsal_btn", disabled: busy || draft.trim() === "", onClick: addRoot, children: "添加" })
					] }),
					h("div", { className: "fsal_hint", children: `配置文件：${state?.file ?? "~/Library/Application Support/dsh-desktop/harness/fs-allowlist.json"}` })
				] }),

				hs("div", { className: "fsal_card", children: [
					hs("div", { className: "fsal_toggleRow", children: [
						hs("div", { className: "fsal_toggleText", children: [
							h("span", { className: "fsal_title", children: "bash 升权自动放行" }),
							h("span", { className: "fsal_hint", children: "bash 命令触发沙箱升权、且理由中提到白名单路径时，自动同意而不弹审批。这是对模型所写理由的文本匹配：未命中仍会正常弹审批。" })
						] }),
						h("button", {
							className: "fsal_switch",
							"data-on": bashOn ? "" : undefined,
							"aria-label": "bash 升权自动放行",
							disabled: busy,
							onClick: toggleBash,
							children: h("span", { className: "fsal_thumb" })
						})
					] })
				] }),

				message ? h("div", { className: "fsal_msg" + (message.error ? " fsal_err" : ""), children: message.text }) : null
			] });
		}

		function apply(ctx) {
			ensureStyle();
			ctx.slots.inject("settings.plugins.tab", () =>
				ctx.slots.register(
					{
						name: "settings.plugins.tab",
						id: "fs-allowlist",
						order: 40,
						label: () => "目录白名单"
					},
					AllowlistTab
				)
			);
		}

		module.exports.apply = apply;
		module.exports.inject = ["slots"];
		return module.exports;
	}
});
