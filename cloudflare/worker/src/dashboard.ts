function dashboardHeaders(): Headers {
  return new Headers({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  });
}

function dashboardHTML(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PodSync 远端管理</title>
  <link rel="icon" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTYiIGZpbGw9IiMyNTYzZWIiLz48cGF0aCBkPSJNMTggMThoMjFhMTMgMTMgMCAwIDEgMCAyNkgyOHYtOWgxMWE0IDQgMCAwIDAgMC04SDI4djI1SDE4eiIgZmlsbD0iI2ZmZiIvPjxjaXJjbGUgY3g9IjQ3IiBjeT0iNDciIHI9IjUiIGZpbGw9IiMyMmM1NWUiLz48L3N2Zz4=">
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --panel-soft: #f8fafc;
      --line: #d9dee7;
      --line-strong: #cbd5e1;
      --text: #172033;
      --muted: #667085;
      --muted-strong: #475467;
      --accent: #2563eb;
      --warn: #b45309;
      --danger: #dc2626;
      --ok: #16a34a;
      --disabled: #98a2b3;
      --shadow: 0 18px 45px rgba(16, 24, 40, 0.18);
      --modal-gap: 24px;
      --modal-available-width: calc(100vw - (var(--modal-gap) * 2));
      --modal-available-height: calc(100dvh - (var(--modal-gap) * 2));
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body.modal-open { overflow: hidden; }
    button, input, select, textarea { font: inherit; }
    button {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--text);
      cursor: pointer;
      min-height: 32px;
      padding: 6px 10px;
    }
    button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #ffffff; }
    button.primary:hover:not(:disabled) { background: #1d4ed8; border-color: #1d4ed8; color: #ffffff; }
    button.danger { color: var(--danger); }
    button.small { min-height: 28px; padding: 4px 8px; font-size: 13px; }
    button.ghost { background: transparent; border-color: transparent; min-height: 28px; padding: 4px 6px; }
    button.ghost:hover:not(:disabled), button.link-button:hover:not(:disabled) {
      border-color: transparent;
      background: transparent;
    }
    button.link-button {
      border-color: transparent;
      background: transparent;
      color: var(--accent);
      min-height: 28px;
      padding: 4px 6px;
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    a { color: var(--accent); }
    main { min-height: 100vh; padding: 0 24px 28px; }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 56px;
      margin: 0 -24px 16px;
      padding: 0 24px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.9);
      position: sticky;
      top: 0;
      z-index: 39;
    }
    .brand, .section-tools, .toolbar-left, .toolbar-right, .chip-row, .actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .brand-logo {
      display: inline-grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background: var(--accent);
      color: #ffffff;
      font-weight: 800;
      letter-spacing: 0;
      line-height: 1;
      position: relative;
      overflow: hidden;
      flex: 0 0 auto;
    }
    .brand-logo::after {
      content: "";
      position: absolute;
      right: 4px;
      bottom: 4px;
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: #22c55e;
      box-shadow: 0 0 0 2px var(--accent);
    }
    .brand h1 { margin: 0; font-size: 20px; line-height: 1.2; white-space: nowrap; }
    .status { min-width: 0; min-height: 0; color: var(--muted); text-align: right; font-size: 13px; }
    .status[hidden] { display: none; }
    .status.error { color: var(--danger); }
    .status.ok { color: var(--ok); }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
    .metric {
      position: relative;
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 6px;
      padding: 14px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .metric span { color: var(--muted); font-size: 15px; font-weight: 600; }
    .metric strong { font-size: 22px; }
    button.metric {
      width: 100%;
      min-height: 0;
      text-align: left;
    }
    button.metric:hover:not(:disabled) { border-color: var(--accent); color: var(--text); }
    .action-metric strong { color: var(--accent); font-size: 18px; }
    #metric-logs { color: var(--text); font-size: 22px; }
    section {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 6px;
      min-width: 0;
    }
    section header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: var(--panel-soft);
      border-radius: 6px 6px 0 0;
    }
    section h2 { font-size: 15px; margin: 0; }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 12px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: #ffffff;
    }
    .toolbar input, .toolbar select, .modal-toolbar input, .modal-toolbar select {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #ffffff;
      color: var(--text);
      min-height: 32px;
      padding: 6px 8px;
    }
    .toolbar select, .modal-toolbar select {
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 20 20' fill='none'%3E%3Cpath d='M6 8l4 4 4-4' stroke='%2398a2b3' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
      background-position: right 11px center;
      background-repeat: no-repeat;
      background-size: 16px 16px;
      padding-right: 36px;
    }
    .toolbar select[hidden] { display: none; }
    .custom-select {
      position: relative;
      min-width: 112px;
      z-index: 35;
    }
    .select-trigger {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      position: relative;
      padding-right: 34px;
      text-align: left;
      white-space: nowrap;
      color: var(--text);
      background: #ffffff;
    }
    .select-trigger::after {
      content: "";
      position: absolute;
      top: 50%;
      right: 12px;
      width: 7px;
      height: 7px;
      border-right: 1.5px solid #98a2b3;
      border-bottom: 1.5px solid #98a2b3;
      transform: translateY(-60%) rotate(45deg);
      pointer-events: none;
    }
    .select-menu {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      z-index: 30;
      min-width: 100%;
      padding: 4px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #ffffff;
      box-shadow: 0 12px 24px rgba(16, 24, 40, 0.16);
    }
    .select-menu[hidden] { display: none; }
    .select-option {
      width: 100%;
      display: block;
      border-color: transparent;
      background: #ffffff;
      color: var(--text);
      text-align: left;
      white-space: nowrap;
    }
    .select-option:hover, .select-option:focus {
      border-color: transparent;
      background: #eff6ff;
      color: var(--accent);
      outline: none;
    }
    .select-option[aria-selected="true"] {
      background: #eff6ff;
      color: var(--accent);
      font-weight: 700;
    }
    .search { min-width: min(340px, 100%); }
    .feed-filter-bar {
      align-items: center;
      flex-wrap: nowrap;
    }
    .feed-filter-bar .search {
      width: 220px;
      flex: 0 1 220px;
    }
    .feed-filter-bar .custom-select {
      flex: 0 0 112px;
    }
    .form-field .custom-select {
      width: 100%;
    }
    .form-field .select-trigger {
      min-height: 32px;
    }
    .modal-toolbar .custom-select {
      flex: 0 0 128px;
    }
    .custom-select.is-disabled .select-trigger {
      cursor: not-allowed;
      opacity: 0.55;
    }
    #reset-feed-filters {
      flex: 0 0 auto;
      white-space: nowrap;
    }
    .form-grid {
      width: 100%;
      max-width: 100%;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px 16px;
      padding: 18px 22px;
      overflow-x: hidden;
    }
    .form-field { display: grid; gap: 4px; min-width: 0; }
    .form-field.wide, .form-section { grid-column: 1 / -1; }
    .form-field label, .form-group-label { color: var(--muted); font-size: 12px; font-weight: 600; }
    .tooltip-label {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      width: max-content;
      max-width: 100%;
      cursor: help;
      outline: none;
    }
    .tooltip-label::after {
      content: "?";
      display: inline-grid;
      place-items: center;
      width: 15px;
      height: 15px;
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      color: var(--muted);
      background: #ffffff;
      font-size: 10px;
      line-height: 1;
    }
    .tooltip-label::before {
      content: attr(data-tooltip);
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 90;
      width: max-content;
      max-width: 260px;
      padding: 8px 10px;
      border-radius: 6px;
      background: #172033;
      color: #ffffff;
      box-shadow: 0 10px 22px rgba(16, 24, 40, 0.22);
      font-size: 12px;
      line-height: 1.4;
      font-weight: 500;
      white-space: normal;
      opacity: 0;
      pointer-events: none;
      transform: translateY(-2px);
      transition: opacity 120ms ease, transform 120ms ease;
    }
    .tooltip-label:hover::before, .tooltip-label:focus-visible::before {
      opacity: 1;
      transform: translateY(0);
    }
    .form-field input, .form-field select, .form-field textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 7px 8px;
      background: #ffffff;
      color: var(--text);
    }
    .form-field textarea { min-height: 58px; resize: vertical; }
    .form-field.has-error label { color: var(--danger); }
    .form-field.has-error input, .form-field.has-error textarea, .form-field.has-error .select-trigger {
      border-color: var(--danger);
      box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.1);
    }
    .form-section { min-width: 0; border: 1px solid var(--line); border-radius: 6px; background: var(--panel-soft); padding: 14px; display: grid; gap: 10px; }
    .form-section[hidden] { display: none; }
    .form-section-header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-width: 0; }
    .form-section-title { color: var(--text); font-size: 13px; font-weight: 700; }
    .form-section-note { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .form-section-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; align-items: start; }
    .form-section-grid.runtime-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .form-section-grid.switch-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; }
    .form-section.danger-zone { background: #fef2f2; border-color: #fecaca; }
    .form-field.checkbox-field { align-content: center; justify-content: start; min-height: 32px; }
    .form-field.checkbox-field.checkbox-start { grid-column: auto; }
    .form-field.checkbox-field label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      width: max-content;
      max-width: 100%;
      color: var(--text);
      font-size: 14px;
      font-weight: 500;
    }
    .form-field.checkbox-field input[type="checkbox"] {
      width: auto;
      flex: 0 0 auto;
      margin: 0;
    }
    .feed-form { display: grid; gap: 0; background: #ffffff; }
    .feed-form[hidden] { display: none; }
    .feed-form-title { display: flex; justify-content: space-between; gap: 10px; align-items: center; padding: 18px 22px; border-bottom: 1px solid var(--line); }
    .feed-form-title strong { font-size: 18px; }
    .feed-form-title span { display: block; margin-top: 3px; color: var(--muted); font-size: 13px; }
    .feed-form .feed-form-title, .feed-form .modal-footer { flex: 0 0 auto; }
    .feed-form .form-grid { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
    .modal-footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 22px; border-top: 1px solid var(--line); background: var(--panel-soft); border-radius: 0 0 6px 6px; }
    .modal-footer-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    section[data-region="feeds"] > .table-wrap table { min-width: 960px; }
    .modal.large .table-wrap table { min-width: 860px; }
    .modal.logs .table-wrap table { min-width: 760px; }
    .modal.logs th, .modal.logs td {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      overflow-wrap: normal;
    }
    th, td { border-bottom: 1px solid var(--line); padding: 10px 12px; text-align: left; vertical-align: middle; overflow-wrap: anywhere; }
    th { color: var(--muted); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; background: #fbfcfd; }
    .sort-header {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 100%;
      min-height: 24px;
      padding: 0;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .sort-header:hover, .sort-header:focus-visible { color: var(--accent); }
    .sort-indicator {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 10px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1;
    }
    .sort-header.active .sort-indicator { color: var(--accent); }
    tbody tr.selected { background: #ffffff; }
    tbody tr.disabled-row { color: var(--text); background: #ffffff; }
    tbody tr:last-child td { border-bottom: 0; }
    .muted { color: var(--muted); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .stack { display: grid; gap: 4px; min-width: 0; }
    .feed-name-stack { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .feed-avatar {
      flex: 0 0 28px;
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #f8fafc;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
    }
    .feed-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .mobile-feed-meta { display: none; }
    .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .feed-title-button {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      font-weight: 600;
      text-align: left;
    }
    .feed-title-button:hover:not(:disabled) {
      border-color: transparent;
      background: transparent;
      color: var(--text);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 5px;
      padding: 2px 8px;
      background: #ffffff;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
    }
    .pill.success, .pill.visible, .pill.ok { color: var(--ok); border-color: #bbf7d0; background: #ecfdf3; }
    .pill.warning, .pill.hidden, .pill.delete_pending, .pill.pending { color: var(--warn); border-color: #fed7aa; background: #fff7ed; }
    .pill.danger, .pill.purged, .pill.error { color: var(--danger); border-color: #fecaca; background: #fef2f2; }
    .pill.disabled { color: #667085; border-color: #e4e7ec; background: #f2f4f7; }
    .pill.info { color: #1d4ed8; border-color: #bfdbfe; background: #eff6ff; }
    .pill.provider-bilibili { color: #0369a1; border-color: #bae6fd; background: #f0f9ff; }
    .pill.provider-youtube { color: #b91c1c; border-color: #fecdd3; background: #fff1f2; }
    .empty { padding: 16px; color: var(--muted); text-align: center; }
    .field-error { color: var(--danger); font-size: 12px; }
    .field-error:not(:empty) { min-height: 16px; margin-top: 2px; }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 40;
      display: grid;
      place-items: center;
      padding: var(--modal-gap);
      background: rgba(52, 64, 84, 0.62);
      overflow: hidden;
      overscroll-behavior: contain;
    }
    .modal-backdrop[hidden] { display: none; }
    .modal {
      width: min(640px, var(--modal-available-width));
      max-height: min(780px, var(--modal-available-height));
      display: flex;
      flex-direction: column;
      border: 1px solid var(--line-strong);
      border-radius: 8px;
      background: #ffffff;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .modal.large { width: min(920px, var(--modal-available-width)); }
    .modal.logs { width: min(820px, var(--modal-available-width)); }
    .modal.small { width: min(440px, var(--modal-available-width)); }
    .modal header, .modal-footer, .modal-toolbar { flex: 0 0 auto; }
    .modal-body { flex: 1 1 auto; min-height: 0; overflow: auto; background: #ffffff; overscroll-behavior: contain; }
    .modal-close {
      width: 30px;
      height: 30px;
      min-height: 30px;
      padding: 0;
      display: inline-grid;
      place-items: center;
      flex: 0 0 auto;
      border-radius: 999px;
      border: 1px solid var(--line-strong);
      background: #ffffff;
      color: var(--muted-strong);
      font-size: 18px;
      line-height: 1;
    }
    .modal-close:hover:not(:disabled) {
      border-color: var(--accent);
      background: #eff6ff;
      color: var(--accent);
    }
    .modal-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 18px; border-bottom: 1px solid var(--line); background: var(--panel-soft); }
    .modal-title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .modal-subtitle { color: var(--muted); font-size: 13px; margin-top: 3px; }
    section[data-region="episodes"] .modal-toolbar .toolbar-left { flex: 1 1 auto; flex-wrap: nowrap; min-width: 0; }
    section[data-region="episodes"] #episode-search { flex: 1 1 auto; min-width: 0; }
    section[data-region="episodes"] .custom-select { flex: 0 0 132px; min-width: 132px; }
    .detail-body { padding: 18px 22px; }
    .detail-chips { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    .detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 18px; margin: 0; }
    .detail-item { min-width: 0; }
    .detail-item.wide { grid-column: 1 / -1; }
    .detail-label { color: var(--muted); font-size: 12px; font-weight: 600; margin: 0 0 4px; }
    .detail-value { margin: 0; min-width: 0; overflow-wrap: anywhere; color: var(--text); }
    .detail-value.mono { font-size: 13px; }
    .log-empty { margin: 18px; border: 1px dashed var(--line-strong); border-radius: 6px; padding: 24px; text-align: center; color: var(--muted); }
    .toast-region {
      position: fixed;
      left: 50%;
      bottom: max(24px, env(safe-area-inset-bottom));
      z-index: 80;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      width: min(520px, calc(100vw - 32px));
      transform: translateX(-50%);
      pointer-events: none;
    }
    .toast {
      max-width: 100%;
      border: 0;
      border-radius: 999px;
      background: rgba(17, 24, 39, 0.94);
      color: #ffffff;
      padding: 10px 16px;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.24);
      text-align: center;
      line-height: 1.45;
      pointer-events: auto;
    }
    .toast button { display: none; }
    .support-panel[hidden] { display: none; }
    .nowrap { white-space: nowrap; }
    .episode-table th, .episode-table td { white-space: nowrap; }
    .episode-title-cell { min-width: 0; }
    .episode-title-link {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }
    .actions { flex-wrap: nowrap; }
    .actions-cell { white-space: nowrap; }
    .mobile-only, .icon-button.mobile-only { display: none; }
    .icon-button {
      position: relative;
      width: 30px;
      height: 30px;
      min-height: 30px;
      padding: 0;
      display: inline-grid;
      place-items: center;
      border-radius: 6px;
      line-height: 1;
      font-weight: 700;
    }
    .icon-button:disabled { opacity: 1; }
    .icon-button:disabled svg { opacity: 0.45; }
    .icon-button[data-tooltip]::after {
      content: attr(data-tooltip);
      position: absolute;
      bottom: calc(100% + 7px);
      left: 50%;
      z-index: 90;
      width: max-content;
      max-width: 180px;
      padding: 6px 8px;
      border-radius: 6px;
      background: #172033;
      color: #ffffff;
      box-shadow: 0 8px 18px rgba(16, 24, 40, 0.18);
      font-size: 12px;
      line-height: 1.35;
      font-weight: 500;
      white-space: nowrap;
      display: none;
      pointer-events: none;
      transform: translate(-50%, 2px);
    }
    .icon-button[data-tooltip]:hover::after,
    .icon-button[data-tooltip]:focus-visible::after {
      display: block;
      transform: translate(-50%, 0);
    }
    .modal header .icon-button[data-tooltip]::after {
      top: calc(100% + 7px);
      bottom: auto;
      transform: translate(-50%, -2px);
    }
    .modal header .icon-button[data-tooltip]:hover::after,
    .modal header .icon-button[data-tooltip]:focus-visible::after {
      transform: translate(-50%, 0);
    }
    .icon-button svg { width: 15px; height: 15px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .icon-button.play svg { fill: currentColor; stroke: none; }
    .icon-button.pause { color: #b45309; border-color: #fed7aa; background: #fff7ed; }
    .icon-button.play { color: #15803d; border-color: #bbf7d0; background: #ecfdf3; }
    .icon-button.edit { color: #2563eb; border-color: #bfdbfe; background: #eff6ff; }
    .icon-button.copy, .icon-button.list { color: #2563eb; border-color: #bfdbfe; background: #eff6ff; }
    .icon-button.refresh { color: #2563eb; border: 0; background: transparent; }
    .icon-button.refresh:hover:not(:disabled) { border: 0; background: #eff6ff; }
    .icon-button.hide { color: #b45309; border-color: #fed7aa; background: #fff7ed; }
    .icon-button.restore { color: #15803d; border-color: #bbf7d0; background: #ecfdf3; }
    .icon-button.delete { color: #dc2626; border-color: #fecaca; background: #fef2f2; }
    @media (max-width: 980px) {
      :root { --modal-gap: 18px; }
      main { padding: 0 14px 20px; }
      .topbar { align-items: center; flex-direction: row; margin: 0 -14px 14px; padding: 12px 14px; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
      .form-grid { grid-template-columns: 1fr; }
      .form-section-grid, .form-section-grid.runtime-grid, .form-section-grid.switch-grid { grid-template-columns: 1fr; }
      .form-section-header { display: grid; gap: 3px; }
      .form-section-note { white-space: normal; }
      .toolbar, .modal-toolbar { align-items: stretch; flex-direction: column; }
      .toolbar-right { justify-content: flex-start; }
      .search { min-width: 0; width: 100%; }
      .feed-filter-bar { align-items: stretch; flex-wrap: wrap; }
      .feed-filter-bar .search { width: 100%; flex: 1 0 100%; }
      .modal-toolbar .custom-select { flex: 0 0 auto; width: 100%; }
      section[data-region="episodes"] .modal-toolbar { align-items: center; flex-direction: row; }
      section[data-region="episodes"] .modal-toolbar .toolbar-left { width: 100%; }
      section[data-region="episodes"] .custom-select { flex: 0 0 132px; width: 132px; min-width: 132px; }
      .status { text-align: left; }
    }
    @media (max-width: 720px) {
      section[data-region="feeds"], section[data-region="feeds"] .toolbar {
        overflow: visible;
      }
      section[data-region="feeds"] .feed-filter-bar {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
        align-items: start;
        gap: 8px;
        width: 100%;
      }
      section[data-region="feeds"] .feed-filter-bar .search {
        grid-column: 1 / -1;
      }
      section[data-region="feeds"] .custom-select {
        min-width: 0;
        width: 100%;
      }
      section[data-region="feeds"] .select-trigger {
        min-width: 0;
        width: 100%;
      }
      section[data-region="feeds"] .select-menu {
        left: 0;
        right: auto;
        width: max-content;
        min-width: 100%;
      }
      section[data-region="feeds"] > .table-wrap { overflow: visible; }
      section[data-region="feeds"] > .table-wrap table {
        min-width: 0;
        table-layout: auto;
      }
      section[data-region="feeds"] thead { display: none; }
      section[data-region="feeds"] tbody {
        display: grid;
        gap: 10px;
        padding: 10px;
      }
      section[data-region="feeds"] tbody tr {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: #ffffff;
        padding: 12px;
      }
      section[data-region="feeds"] tbody tr.selected {
        border-color: var(--line);
        background: #ffffff;
      }
      section[data-region="feeds"] tbody tr.disabled-row {
        background: #ffffff;
      }
      section[data-region="feeds"] tbody td {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        border: 0;
        padding: 0;
      }
      section[data-region="feeds"] tbody td::before {
        content: none;
      }
      section[data-region="feeds"] tbody td:first-child {
        flex: 1 0 100%;
      }
      section[data-region="feeds"] tbody td:first-child::before,
      section[data-region="feeds"] tbody td.empty::before {
        content: none;
      }
      section[data-region="feeds"] .feed-name-stack {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 7px;
      }
      section[data-region="feeds"] .mobile-feed-meta {
        display: inline-flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
      }
      section[data-region="feeds"] .provider-cell,
      section[data-region="feeds"] .status-cell,
      section[data-region="feeds"] .activity-cell,
      section[data-region="feeds"] .episodes-cell,
      section[data-region="feeds"] .subscription-cell {
        display: none;
      }
      section[data-region="feeds"] .feed-title-button {
        width: auto;
        max-width: 100%;
        min-height: 24px;
        padding: 0;
        border: 0;
        background: transparent;
        font-size: 15px;
      }
      section[data-region="feeds"] .actions-cell {
        flex: 1 0 100%;
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 10px;
        padding-top: 2px;
      }
      section[data-region="feeds"] .actions-cell .actions {
        margin-left: 0;
      }
      section[data-region="feeds"] .actions-cell .mobile-only {
        display: inline-grid;
      }
      section[data-region="episodes"].modal {
        width: min(420px, var(--modal-available-width));
        max-height: var(--modal-available-height);
      }
      section[data-region="episodes"] header {
        align-items: flex-start;
        padding: 12px 14px;
      }
      section[data-region="episodes"] header .ghost {
        min-height: 28px;
        padding: 4px 6px;
      }
      section[data-region="episodes"] .modal-toolbar {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 8px;
        padding: 12px 14px;
        background: #ffffff;
      }
      section[data-region="episodes"] .toolbar-left {
        display: flex;
        align-items: center;
        flex-wrap: nowrap;
        gap: 8px;
        width: 100%;
        min-width: 0;
      }
      section[data-region="episodes"] #episode-search {
        flex: 1 1 auto;
        min-width: 0;
      }
      section[data-region="episodes"] .custom-select {
        flex: 0 0 132px;
        width: 132px;
        min-width: 132px;
      }
      section[data-region="episodes"] .table-wrap {
        overflow: visible;
      }
      section[data-region="episodes"].modal .episode-table {
        min-width: 0;
        width: 100%;
        table-layout: auto;
      }
      section[data-region="episodes"] thead {
        display: none;
      }
      section[data-region="episodes"] tbody {
        display: grid;
        gap: 10px;
        padding: 12px 14px;
        min-width: 0;
      }
      section[data-region="episodes"] tbody tr {
        width: 100%;
        max-width: 100%;
        min-width: 0;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: #ffffff;
        padding: 12px;
        overflow: hidden;
      }
      section[data-region="episodes"] tbody td {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        border: 0;
        padding: 3px 8px;
        border-radius: 5px;
        background: #f9fafb;
        color: var(--text);
        font-size: 12px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        justify-self: start;
      }
      section[data-region="episodes"] tbody td::before {
        content: attr(data-label);
        color: var(--muted);
        font-weight: 600;
      }
      section[data-region="episodes"] tbody td.empty {
        flex: 1 0 100%;
        justify-content: center;
        padding: 18px 10px;
        background: transparent;
      }
      section[data-region="episodes"] tbody td.empty::before,
      section[data-region="episodes"] .episode-title-cell::before,
      section[data-region="episodes"] .episode-status-cell::before,
      section[data-region="episodes"] .actions-cell::before {
        content: none;
      }
      section[data-region="episodes"] .episode-title-cell {
        order: 1;
        flex: 1 0 100%;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        display: block;
        padding: 0;
        background: transparent;
      }
      section[data-region="episodes"] .episode-title-link {
        width: 100%;
        max-width: 100%;
        font-size: 14px;
      }
      section[data-region="episodes"] .episode-published-cell {
        order: 2;
        flex: 0 1 auto;
        max-width: 100%;
      }
      section[data-region="episodes"] .episode-duration-cell {
        order: 3;
        flex: 0 1 auto;
      }
      section[data-region="episodes"] .episode-size-cell {
        order: 4;
        flex: 0 1 auto;
      }
      section[data-region="episodes"] .episode-status-cell {
        order: 6;
        flex: 0 0 auto;
        justify-self: start;
        padding: 0;
        background: transparent;
      }
      section[data-region="episodes"] .actions-cell {
        order: 5;
        flex: 0 0 auto;
        justify-self: start;
        justify-content: flex-start;
        padding: 0;
        background: transparent;
      }
      section[data-region="episodes"] .actions-cell .actions {
        margin-left: 0;
        justify-content: flex-start;
      }
      section[data-region="episodes"] .modal-footer {
        padding: 12px 14px;
      }
    }
    @media (max-width: 360px) {
      :root { --modal-gap: 10px; }
      section[data-region="feeds"] .feed-filter-bar {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      }
      section[data-region="feeds"] #reset-feed-filters {
        grid-column: 1 / -1;
        justify-self: end;
      }
    }
  </style>
</head>
<body>
  <main id="app" data-dashboard-app>
    <header class="topbar">
      <div class="brand">
        <span class="brand-logo" aria-hidden="true">P</span>
        <h1>Podsync Dashboard</h1>
      </div>
    </header>

    <div class="summary" aria-label="概览">
      <div class="metric"><span>订阅源总数</span><strong id="metric-feeds">-</strong></div>
      <div class="metric"><span>已启用</span><strong id="metric-enabled">-</strong></div>
      <button id="open-logs" class="metric action-metric" type="button"><span>查看日志</span><strong id="metric-logs">-</strong></button>
      <button id="copy-opml" class="metric action-metric" type="button"><span>订阅导出</span><strong>OPML</strong></button>
    </div>

    <section data-region="feeds" aria-labelledby="feeds-title">
      <header>
        <h2 id="feeds-title">订阅源</h2>
        <div class="section-tools">
          <button id="new-feed" class="primary" type="button">添加订阅源</button>
        </div>
      </header>
      <div class="toolbar">
        <div class="toolbar-left feed-filter-bar">
          <input id="feed-search" class="search" type="search" placeholder="搜索订阅源..." autocomplete="off">
          <select id="provider-filter" aria-label="按平台筛选" hidden aria-hidden="true" tabindex="-1">
            <option value="">全部平台</option>
            <option value="bilibili">B 站</option>
            <option value="youtube">YouTube</option>
          </select>
          <div class="custom-select" data-select-control="provider-filter">
            <button id="provider-filter-trigger" class="select-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="provider-filter-menu">全部平台</button>
            <div id="provider-filter-menu" class="select-menu" role="listbox" aria-label="按平台筛选" hidden>
              <button class="select-option" type="button" role="option" data-select-value="" aria-selected="true">全部平台</button>
              <button class="select-option" type="button" role="option" data-select-value="bilibili" aria-selected="false">B 站</button>
              <button class="select-option" type="button" role="option" data-select-value="youtube" aria-selected="false">YouTube</button>
            </div>
          </div>
          <select id="feed-state-filter" aria-label="按状态筛选" hidden aria-hidden="true" tabindex="-1">
            <option value="">全部状态</option>
            <option value="enabled">已启用</option>
            <option value="disabled">已停用</option>
            <option value="needs_cookie">需要 Cookie</option>
          </select>
          <div class="custom-select" data-select-control="feed-state-filter">
            <button id="feed-state-filter-trigger" class="select-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="feed-state-filter-menu">全部状态</button>
            <div id="feed-state-filter-menu" class="select-menu" role="listbox" aria-label="按状态筛选" hidden>
              <button class="select-option" type="button" role="option" data-select-value="" aria-selected="true">全部状态</button>
              <button class="select-option" type="button" role="option" data-select-value="enabled" aria-selected="false">已启用</button>
              <button class="select-option" type="button" role="option" data-select-value="disabled" aria-selected="false">已停用</button>
              <button class="select-option" type="button" role="option" data-select-value="needs_cookie" aria-selected="false">需要 Cookie</button>
            </div>
          </div>
          <button id="reset-feed-filters" type="button">重置筛选</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width: 32%" aria-sort="none"><button class="sort-header" type="button" data-sort-key="title">订阅源<span class="sort-indicator" aria-hidden="true"></span></button></th>
              <th style="width: 8%" aria-sort="none"><button class="sort-header" type="button" data-sort-key="provider">平台<span class="sort-indicator" aria-hidden="true"></span></button></th>
              <th style="width: 9%" aria-sort="none"><button class="sort-header" type="button" data-sort-key="status">状态<span class="sort-indicator" aria-hidden="true"></span></button></th>
              <th style="width: 15%" aria-sort="descending"><button class="sort-header active desc" type="button" data-sort-key="last_updated">最近更新<span class="sort-indicator" aria-hidden="true">↓</span></button></th>
              <th style="width: 11%" aria-sort="none"><button class="sort-header" type="button" data-sort-key="episodes">剧集<span class="sort-indicator" aria-hidden="true"></span></button></th>
              <th style="width: 8%" aria-sort="none"><button class="sort-header" type="button" data-sort-key="subscription">订阅<span class="sort-indicator" aria-hidden="true"></span></button></th>
              <th style="width: 17%">操作</th>
            </tr>
          </thead>
          <tbody id="feeds-body"></tbody>
        </table>
      </div>
    </section>

    <section data-region="subscriptions" class="support-panel" aria-labelledby="subscriptions-title" hidden>
      <header><h2 id="subscriptions-title">订阅地址</h2></header>
      <div id="subscription-feeds" class="url-list"></div>
      <div id="subscription-opml" class="url-list"></div>
    </section>
    <section data-region="runs" class="support-panel" aria-labelledby="runs-title" hidden>
      <header><h2 id="runs-title">同步记录</h2></header>
      <table><tbody id="runs-body"></tbody></table>
    </section>

    <div id="feed-modal" class="modal-backdrop" hidden role="dialog" aria-modal="true" aria-labelledby="feed-form-title">
      <form id="feed-form" class="feed-form modal" data-feed-form hidden>
        <div class="feed-form-title">
          <div>
            <strong id="feed-form-title">添加订阅源</strong>
            <span id="feed-form-subtitle">配置远端订阅源，下次 NAS 同步时生效</span>
          </div>
          <button id="feed-form-close" class="modal-close" type="button" aria-label="关闭">x</button>
        </div>
        <div class="form-grid">
          <div class="form-section">
            <div class="form-section-header">
              <span class="form-section-title">基础信息</span>
              <span class="form-section-note">必填</span>
            </div>
            <div class="form-section-grid">
              <div class="form-field">
                <label class="tooltip-label" tabindex="0" for="feed-id" data-tooltip="远端配置里的唯一标识，会用于订阅路径和本地匹配；创建后不建议修改。">订阅源 ID</label>
                <input id="feed-id" type="text" autocomplete="off" placeholder="例如 bilibili-10835521 或 youtube-maker" aria-required="true" aria-describedby="feed-id-error">
                <div id="feed-id-error" class="field-error" aria-live="polite"></div>
              </div>
              <div class="form-field">
                <label class="tooltip-label" tabindex="0" for="feed-provider" data-tooltip="选择来源平台，决定使用 B 站或 YouTube 的解析规则；默认 YouTube。">平台</label>
                <select id="feed-provider" hidden aria-hidden="true" tabindex="-1">
                  <option value="youtube">YouTube</option>
                  <option value="bilibili">B 站</option>
                </select>
                <div class="custom-select" data-select-control="feed-provider">
                  <button id="feed-provider-trigger" class="select-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="feed-provider-menu">YouTube</button>
                  <div id="feed-provider-menu" class="select-menu" role="listbox" aria-label="平台" hidden>
                    <button class="select-option" type="button" role="option" data-select-value="youtube" aria-selected="true">YouTube</button>
                    <button class="select-option" type="button" role="option" data-select-value="bilibili" aria-selected="false">B 站</button>
                  </div>
                </div>
              </div>
              <div class="form-field wide">
                <label class="tooltip-label" tabindex="0" for="feed-url" data-tooltip="要同步的视频空间、频道或播放列表地址，NAS 会按这个来源抓取内容。">来源 URL</label>
                <input id="feed-url" type="text" autocomplete="off" placeholder="例如 space.bilibili.com/10835521 或 youtube.com/@maker" aria-required="true" aria-describedby="feed-url-error">
                <div id="feed-url-error" class="field-error" aria-live="polite"></div>
              </div>
            </div>
          </div>

          <div class="form-section">
            <div class="form-section-header">
              <span class="form-section-title">发布设置</span>
            </div>
            <div class="form-section-grid switch-grid">
              <div class="form-field checkbox-field">
                <label class="tooltip-label" tabindex="0" data-tooltip="开启后 NAS 会同步这个订阅源；默认开启。"><input id="feed-enabled" type="checkbox"> 启用同步</label>
              </div>
              <div class="form-field checkbox-field">
                <label class="tooltip-label" tabindex="0" data-tooltip="开启后导出的 OPML 会包含这个订阅源；默认开启。"><input id="feed-include-in-opml" type="checkbox"> 加入 OPML</label>
              </div>
              <div class="form-field checkbox-field">
                <label class="tooltip-label" tabindex="0" data-tooltip="开启后生成带随机路径的订阅地址，避免公开可猜；默认开启。"><input id="feed-private-feed" type="checkbox"> 私密订阅链接</label>
              </div>
              <div id="feed-bilibili-options" class="form-field checkbox-field">
                <label class="tooltip-label" tabindex="0" data-tooltip="B 站专用；需要 NAS 本地 cookie 支持充电或 UP 主专属内容，默认关闭。"><input id="feed-bilibili-include-upower" type="checkbox"> 包含 UP 主专属内容</label>
              </div>
            </div>
          </div>

          <div class="form-section">
            <div class="form-section-header">
              <span class="form-section-title">展示覆盖</span>
              <span class="form-section-note">可选</span>
            </div>
            <div class="form-section-grid">
              <div class="form-field">
                <label class="tooltip-label" tabindex="0" for="feed-title-override" data-tooltip="留空时使用平台返回的标题；填写后远端订阅会优先显示这个标题。">标题覆盖</label>
                <input id="feed-title-override" type="text" autocomplete="off" placeholder="例如 影视飓风精选">
              </div>
              <div class="form-field">
                <label class="tooltip-label" tabindex="0" for="feed-cookie-profile" data-tooltip="NAS 本地 cookie 配置名，用于需要登录态的内容；留空表示不使用 cookie。">Cookie 配置</label>
                <input id="feed-cookie-profile" type="text" autocomplete="off" placeholder="例如 bilibili-main">
              </div>
              <div class="form-field wide">
                <label class="tooltip-label" tabindex="0" for="feed-description-override" data-tooltip="留空时使用平台返回的描述；填写后覆盖远端 RSS 的订阅描述。">描述覆盖</label>
                <textarea id="feed-description-override" placeholder="例如 科技、影像和幕后访谈"></textarea>
              </div>
            </div>
          </div>

          <div class="form-section">
            <div class="form-section-header">
              <span class="form-section-title">抓取参数</span>
            </div>
            <div class="form-section-grid runtime-grid">
              <div class="form-field">
                <label class="tooltip-label" tabindex="0" for="feed-update-period" data-tooltip="NAS 拉取配置后按这个间隔尝试更新；使用 Go duration 写法，默认 1h。">更新周期</label>
                <input id="feed-update-period" type="text" autocomplete="off" placeholder="默认 1h，例如 30m、2h" aria-required="true" aria-describedby="feed-update-period-error">
                <div id="feed-update-period-error" class="field-error" aria-live="polite"></div>
              </div>
              <div class="form-field">
                <label class="tooltip-label" tabindex="0" for="feed-page-size" data-tooltip="每次从来源拉取的条目数量，默认 25。">每页数量</label>
                <input id="feed-page-size" type="number" min="1" step="1" placeholder="默认 25" aria-required="true" aria-describedby="feed-page-size-error">
                <div id="feed-page-size-error" class="field-error" aria-live="polite"></div>
              </div>
              <div class="form-field">
                <label class="tooltip-label" tabindex="0" for="feed-keep-last" data-tooltip="远端每个订阅源保留的最近剧集数量；0 表示不限制，默认 25。">保留最近</label>
                <input id="feed-keep-last" type="number" min="0" step="1" placeholder="默认 25，0 表示不限制" aria-required="true" aria-describedby="feed-keep-last-error">
                <div id="feed-keep-last-error" class="field-error" aria-live="polite"></div>
              </div>
            </div>
          </div>

          <div class="form-section">
            <div class="form-section-header">
              <span class="form-section-title">过滤规则</span>
              <span class="form-section-note">可选，留空表示不过滤</span>
            </div>
            <div class="form-section-grid">
              <div class="form-field">
                <label class="tooltip-label" tabindex="0" for="feed-filter-title" data-tooltip="只保留标题匹配该正则的剧集；留空表示不限制。">标题包含</label>
                <input id="feed-filter-title" type="text" autocomplete="off" placeholder="例如 访谈|幕后">
              </div>
              <div class="form-field">
                <label class="tooltip-label" tabindex="0" for="feed-filter-not-title" data-tooltip="排除标题匹配该正则的剧集；留空表示不排除。">标题不包含</label>
                <input id="feed-filter-not-title" type="text" autocomplete="off" placeholder="例如 直播|预告">
              </div>
              <div class="form-field">
                <label class="tooltip-label" tabindex="0" for="feed-filter-description" data-tooltip="只保留描述匹配该正则的剧集；留空表示不限制。">描述包含</label>
                <input id="feed-filter-description" type="text" autocomplete="off" placeholder="例如 嘉宾|完整版">
              </div>
              <div class="form-field">
                <label class="tooltip-label" tabindex="0" for="feed-filter-not-description" data-tooltip="排除描述匹配该正则的剧集；留空表示不排除。">描述不包含</label>
                <input id="feed-filter-not-description" type="text" autocomplete="off" placeholder="例如 抽奖|片段">
              </div>
              <div class="form-field">
                <label class="tooltip-label" tabindex="0" for="feed-filter-min-duration" data-tooltip="排除短于 N 秒的剧集；留空表示不限制。">最小时长</label>
                <input id="feed-filter-min-duration" type="number" min="0" step="1" placeholder="秒，例如 600">
              </div>
              <div class="form-field">
                <label class="tooltip-label" tabindex="0" for="feed-filter-max-duration" data-tooltip="排除长于 N 秒的剧集；留空表示不限制。">最大时长</label>
                <input id="feed-filter-max-duration" type="number" min="0" step="1" placeholder="秒，例如 10800">
              </div>
              <div class="form-field">
                <label class="tooltip-label" tabindex="0" for="feed-filter-min-age" data-tooltip="跳过发布不到 N 天的新剧集；留空表示不限制。">最短发布天数</label>
                <input id="feed-filter-min-age" type="number" min="0" step="1" placeholder="天，例如 1">
              </div>
              <div class="form-field">
                <label class="tooltip-label" tabindex="0" for="feed-filter-max-age" data-tooltip="跳过发布超过 N 天的旧剧集；留空表示不限制。">最长发布天数</label>
                <input id="feed-filter-max-age" type="number" min="0" step="1" placeholder="天，例如 90">
              </div>
            </div>
          </div>
          <div id="feed-danger-zone" class="form-section danger-zone" hidden>
            <span class="form-group-label">危险操作</span>
            <div class="section-tools">
              <button id="feed-modal-disable" type="button">停用订阅源</button>
              <button id="feed-modal-delete" class="danger" type="button">删除订阅源</button>
            </div>
            <div class="muted">停用：保留远端配置、RSS/OPML 和已发布内容，只让 NAS 后续不再抓取这个源，可随时恢复。删除：从远端配置、RSS 和 OPML 中移除订阅源，并把相关 R2 媒体标记为待清理；不会删除 NAS 本地文件。</div>
          </div>
        </div>
        <div class="modal-footer">
          <span class="muted">保存后下次 NAS 拉取配置时生效</span>
          <div class="modal-footer-actions">
            <button id="feed-form-cancel" type="button">取消</button>
            <button id="feed-form-save" class="primary" type="submit">保存变更</button>
          </div>
        </div>
      </form>
    </div>

    <div id="feed-details-modal" class="modal-backdrop" hidden role="dialog" aria-modal="true" aria-labelledby="feed-details-title">
      <section class="modal feed-details" data-region="feed-details" aria-labelledby="feed-details-title">
        <header>
          <div>
            <h2 id="feed-details-title">订阅源信息</h2>
            <div id="feed-details-subtitle" class="modal-subtitle">查看订阅源配置和发布状态</div>
          </div>
          <button id="feed-details-close" class="modal-close" type="button" aria-label="关闭">x</button>
        </header>
        <div id="feed-details-body" class="modal-body detail-body"></div>
        <footer class="modal-footer">
          <span id="feed-details-footer" class="muted">-</span>
          <button id="feed-details-footer-close" class="primary" type="button">关闭</button>
        </footer>
      </section>
    </div>

    <div id="episodes-modal" class="modal-backdrop" hidden role="dialog" aria-modal="true" aria-labelledby="episodes-title">
      <section class="modal large" data-region="episodes" aria-labelledby="episodes-title">
        <header>
          <div>
            <div class="modal-title-row">
              <h2 id="episodes-title">剧集列表</h2>
              <button id="refresh-episodes" class="icon-button refresh" type="button" aria-label="刷新剧集" data-tooltip="刷新剧集">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>
              </button>
            </div>
            <div id="episodes-subtitle" class="modal-subtitle">选择订阅源后查看剧集</div>
          </div>
          <button id="episodes-close" class="modal-close" type="button" aria-label="关闭">x</button>
        </header>
        <div class="modal-toolbar">
          <div class="toolbar-left">
            <input id="episode-search" type="search" placeholder="搜索剧集..." autocomplete="off">
            <select id="episode-status-filter" aria-label="剧集状态筛选" hidden aria-hidden="true" tabindex="-1">
              <option value="">全部剧集</option>
              <option value="visible">已发布</option>
              <option value="hidden">已隐藏</option>
              <option value="delete_pending">等待删除</option>
              <option value="purged">已清理</option>
              <option value="pending">待处理</option>
            </select>
            <div class="custom-select" data-select-control="episode-status-filter">
              <button id="episode-status-filter-trigger" class="select-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="episode-status-filter-menu">全部剧集</button>
              <div id="episode-status-filter-menu" class="select-menu" role="listbox" aria-label="剧集状态筛选" hidden>
                <button class="select-option" type="button" role="option" data-select-value="" aria-selected="true">全部剧集</button>
                <button class="select-option" type="button" role="option" data-select-value="visible" aria-selected="false">已发布</button>
                <button class="select-option" type="button" role="option" data-select-value="hidden" aria-selected="false">已隐藏</button>
                <button class="select-option" type="button" role="option" data-select-value="delete_pending" aria-selected="false">等待删除</button>
                <button class="select-option" type="button" role="option" data-select-value="purged" aria-selected="false">已清理</button>
                <button class="select-option" type="button" role="option" data-select-value="pending" aria-selected="false">待处理</button>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-body">
          <div class="table-wrap">
            <table class="episode-table">
              <thead>
                <tr>
                  <th style="width: 36%">剧集</th>
                  <th style="width: 16%">发布时间</th>
                  <th style="width: 9%">时长</th>
                  <th style="width: 10%">大小</th>
                  <th style="width: 12%">状态</th>
                  <th style="width: 17%">操作</th>
                </tr>
              </thead>
              <tbody id="episodes-body"></tbody>
            </table>
          </div>
        </div>
        <footer class="modal-footer">
          <span id="episodes-pagination" class="muted">-</span>
          <button id="episodes-footer-close" class="primary" type="button">关闭</button>
        </footer>
      </section>
    </div>

    <div id="logs-modal" class="modal-backdrop" hidden role="dialog" aria-modal="true" aria-labelledby="events-title">
      <section class="modal logs" data-region="events" aria-labelledby="events-title">
        <header>
          <div>
            <h2 id="events-title">运行日志</h2>
            <div id="logs-subtitle" class="modal-subtitle">从最近联系打开</div>
          </div>
        </header>
        <div class="modal-toolbar">
          <div class="toolbar-left">
            <select id="event-level-filter" aria-label="日志等级筛选" hidden aria-hidden="true" tabindex="-1">
              <option value="">全部等级</option>
              <option value="info">信息</option>
              <option value="success">成功</option>
              <option value="warning">警告</option>
              <option value="error">错误</option>
            </select>
            <div class="custom-select" data-select-control="event-level-filter">
              <button id="event-level-filter-trigger" class="select-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="event-level-filter-menu">全部等级</button>
              <div id="event-level-filter-menu" class="select-menu" role="listbox" aria-label="日志等级筛选" hidden>
                <button class="select-option" type="button" role="option" data-select-value="" aria-selected="true">全部等级</button>
                <button class="select-option" type="button" role="option" data-select-value="info" aria-selected="false">信息</button>
                <button class="select-option" type="button" role="option" data-select-value="success" aria-selected="false">成功</button>
                <button class="select-option" type="button" role="option" data-select-value="warning" aria-selected="false">警告</button>
                <button class="select-option" type="button" role="option" data-select-value="error" aria-selected="false">错误</button>
              </div>
            </div>
            <button id="copy-logs" type="button">复制日志</button>
          </div>
          <button id="refresh-logs" type="button">刷新</button>
        </div>
        <div class="modal-body">
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th style="width: 22%">时间</th><th style="width: 10%">等级</th><th style="width: 24%">来源</th><th style="width: 44%">消息</th></tr>
              </thead>
              <tbody id="events-body"></tbody>
            </table>
          </div>
          <div id="logs-empty-filter" class="log-empty" hidden>
            <strong>没有匹配的日志</strong>
            <div>可以尝试切换等级筛选。</div>
            <button id="reset-event-filter" type="button">重置筛选</button>
          </div>
        </div>
        <footer class="modal-footer">
          <span class="muted">展示最近 100 条关键事件</span>
          <button id="logs-footer-close" type="button">关闭</button>
        </footer>
      </section>
    </div>

    <div id="confirm-modal" class="modal-backdrop" hidden role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <section class="modal small" aria-labelledby="confirm-title">
        <header>
          <h2 id="confirm-title">确认操作</h2>
          <button id="confirm-close" class="modal-close" type="button" aria-label="关闭">x</button>
        </header>
        <div class="modal-body" style="padding: 18px 22px;"><p id="confirm-message" class="muted" style="margin: 0;"></p></div>
        <footer class="modal-footer">
          <span></span>
          <div class="modal-footer-actions">
            <button id="confirm-cancel" type="button">取消</button>
            <button id="confirm-ok" class="danger" type="button">确认</button>
          </div>
        </footer>
      </section>
    </div>

    <div id="toast-region" class="toast-region" aria-live="polite" aria-atomic="true"></div>
    <div id="dashboard-status" class="status" role="status" aria-live="polite" hidden></div>
  </main>

  <script>
    (function () {
      "use strict";

      var paths = {
        feeds: "/api/admin/feeds",
        subscriptions: "/api/admin/subscriptions",
        episodes: "/api/admin/episodes",
        feedUpsert: "/api/admin/feeds/upsert",
        feedStatus: "/api/admin/feeds/status",
        feedDelete: "/api/admin/feeds/delete",
        episodeStatus: "/api/admin/episodes/status",
        syncRuns: "/api/admin/sync-runs?limit=10",
        events: "/api/admin/events?limit=25"
      };

      var state = {
        feeds: [],
        subscriptions: { feeds: [], opml: [] },
        episodes: [],
        syncRuns: [],
        events: [],
        selectedFeedID: "",
        episodeStatus: "",
        episodeSearch: "",
        feedSearch: "",
        providerFilter: "",
        feedStateFilter: "",
        feedSortKey: "last_updated",
        feedSortDirection: "desc",
        eventLevelFilter: "",
        feedDetailsOpen: false,
        detailsFeedID: "",
        feedFormOpen: false,
        feedFormMode: "create",
        editingFeedID: "",
        busy: false,
        confirmAction: null
      };

      var feedFormFieldIDs = [
        "feed-id",
        "feed-provider",
        "feed-url",
        "feed-title-override",
        "feed-description-override",
        "feed-enabled",
        "feed-include-in-opml",
        "feed-private-feed",
        "feed-bilibili-include-upower",
        "feed-update-period",
        "feed-page-size",
        "feed-keep-last",
        "feed-cookie-profile",
        "feed-filter-title",
        "feed-filter-not-title",
        "feed-filter-description",
        "feed-filter-not-description",
        "feed-filter-min-duration",
        "feed-filter-max-duration",
        "feed-filter-min-age",
        "feed-filter-max-age"
      ];

      function byID(id) { return document.getElementById(id); }

      function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
      }

      function setStatus(message, kind) {
        var node = byID("dashboard-status");
        node.className = "status" + (kind ? " " + kind : "");
        node.textContent = message;
        node.hidden = true;
      }

      function showError(error) {
        var message = error instanceof Error ? error.message : String(error);
        setStatus(message, "error");
        showToast(message, "error");
      }

      async function api(path, options) {
        var init = options || {};
        var headers = Object.assign({ accept: "application/json" }, init.headers || {});
        var response = await fetch(path, Object.assign({}, init, { headers: headers }));
        if (!response.ok) {
          var detail = await response.text();
          throw new Error(detail || ("HTTP " + response.status + " for " + path));
        }
        return response.json();
      }

      function postJSON(path, body) {
        return api(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
      }

      function setDisabled(id, value) {
        var node = byID(id);
        if (node) node.disabled = value;
      }

      function setBusy(value) {
        var changed = state.busy !== value;
        state.busy = value;
        setDisabled("refresh-episodes", value || !state.selectedFeedID);
        setDisabled("new-feed", value);
        setDisabled("feed-form-save", value || !state.feedFormOpen);
        setDisabled("feed-form-cancel", value);
        setDisabled("copy-opml", value);
        if (changed && !value) {
          renderFeeds();
          renderEpisodes();
        }
      }

      function emptyRow(colspan, message) {
        var row = el("tr");
        var cell = el("td", "empty", message);
        cell.colSpan = colspan;
        row.appendChild(cell);
        return row;
      }

      function appendCell(row, childOrText, className, label) {
        var cell = el("td", className || "");
        if (label) cell.setAttribute("data-label", label);
        if (childOrText instanceof Node) {
          cell.appendChild(childOrText);
        } else if (childOrText !== undefined && childOrText !== null) {
          cell.textContent = String(childOrText);
        }
        row.appendChild(cell);
        return cell;
      }

      function formatDate(value) {
        if (!value) return "-";
        var date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString();
      }

      function formatRelative(value) {
        if (!value) return "暂无记录";
        var date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        var seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
        if (seconds < 60) return "刚刚";
        var minutes = Math.floor(seconds / 60);
        if (minutes < 60) return minutes + " 分钟前";
        var hours = Math.floor(minutes / 60);
        if (hours < 24) return hours + " 小时前";
        return Math.floor(hours / 24) + " 天前";
      }

      function formatBytes(value) {
        if (!value || value <= 0) return "-";
        var units = ["B", "KB", "MB", "GB"];
        var size = Number(value);
        var unit = 0;
        while (size >= 1024 && unit < units.length - 1) {
          size = size / 1024;
          unit++;
        }
        return size.toFixed(unit === 0 ? 0 : 1) + " " + units[unit];
      }

      function formatDuration(value) {
        if (!value || value <= 0) return "-";
        var minutes = Math.round(Number(value) / 60);
        if (!Number.isFinite(minutes) || minutes <= 0) return "-";
        return minutes + " 分钟";
      }

      function displayValue(value) {
        return value === null || value === undefined || value === "" ? "-" : String(value);
      }

      function formatBoolean(value) {
        return value ? "是" : "否";
      }

      function safeExternalURL(value) {
        if (!value) return "";
        try {
          var url = new URL(value, window.location.origin);
          if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
        } catch (error) {
          return "";
        }
        return "";
      }

      function safeImageURL(value) {
        if (!value) return "";
        try {
          var url = new URL(value, window.location.origin);
          if (url.protocol === "https:" || url.protocol === "data:") return url.toString();
        } catch (error) {
          return "";
        }
        return "";
      }

      function fallbackCopy(value) {
        var input = document.createElement("input");
        input.value = value;
        input.setAttribute("readonly", "readonly");
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        input.remove();
        setStatus("已复制", "ok");
        showToast("已复制到剪贴板", "success");
      }

      function copyText(value) {
        if (!value) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(value).then(function () {
            setStatus("已复制", "ok");
            showToast("已复制到剪贴板", "success");
          }).catch(function () {
            fallbackCopy(value);
          });
          return;
        }
        fallbackCopy(value);
      }

      function showToast(message, kind) {
        var region = byID("toast-region");
        var toast = el("div", "toast " + (kind || "info"));
        toast.appendChild(el("span", "", message));
        region.appendChild(toast);
        window.setTimeout(function () { toast.remove(); }, 4200);
      }

      function findFeedByID(feedID) {
        return state.feeds.find(function (feed) { return feed.feed_id === feedID; }) || null;
      }

      function linkValue(value) {
        var text = displayValue(value);
        var safeURL = safeExternalURL(value);
        if (!safeURL) return text;
        var link = el("a", "", text);
        link.href = safeURL;
        link.rel = "noopener noreferrer";
        link.target = "_blank";
        return link;
      }

      function appendDetailItem(container, label, value, wide) {
        var item = el("div", "detail-item" + (wide ? " wide" : ""));
        item.appendChild(el("dt", "detail-label", label));
        var detail = el("dd", "detail-value");
        if (value instanceof Node) {
          detail.appendChild(value);
        } else {
          detail.textContent = displayValue(value);
        }
        item.appendChild(detail);
        container.appendChild(item);
      }

      function feedFilterSummary(feed) {
        var filters = feed.filters || {};
        var parts = [];
        if (filters.title) parts.push("标题包含：" + filters.title);
        if (filters.not_title) parts.push("标题不包含：" + filters.not_title);
        if (filters.description) parts.push("描述包含：" + filters.description);
        if (filters.not_description) parts.push("描述不包含：" + filters.not_description);
        if (filters.min_duration !== null && filters.min_duration !== undefined) parts.push("最小时长：" + filters.min_duration);
        if (filters.max_duration !== null && filters.max_duration !== undefined) parts.push("最大时长：" + filters.max_duration);
        if (filters.min_age !== null && filters.min_age !== undefined) parts.push("最短发布天数：" + filters.min_age);
        if (filters.max_age !== null && filters.max_age !== undefined) parts.push("最长发布天数：" + filters.max_age);
        return parts.length ? parts.join("；") : "无";
      }

      function emptyFilters() {
        return {
          title: null,
          not_title: null,
          description: null,
          not_description: null,
          min_duration: null,
          max_duration: null,
          min_age: null,
          max_age: null
        };
      }

      function defaultFeedFormValues() {
        return {
          feed_id: "",
          provider: "youtube",
          url: "",
          title_override: null,
          description_override: null,
          enabled: true,
          include_in_opml: true,
          private_feed: true,
          update_period: "1h",
          page_size: 25,
          keep_last: 25,
          cookie_profile: null,
          bilibili: { include_upower_exclusive: false },
          filters: emptyFilters()
        };
      }

      function valueOrDefault(value, fallback) {
        return value === null || value === undefined ? fallback : value;
      }

      function feedFormValuesFromFeed(feed) {
        var filters = feed.filters || {};
        return {
          feed_id: feed.feed_id,
          provider: feed.provider,
          url: feed.url || "",
          title_override: feed.title_override,
          description_override: feed.description_override,
          enabled: Boolean(feed.enabled),
          include_in_opml: Boolean(feed.include_in_opml),
          private_feed: Boolean(feed.private_feed),
          update_period: feed.update_period || "1h",
          page_size: valueOrDefault(feed.page_size, 25),
          keep_last: valueOrDefault(feed.keep_last, 25),
          cookie_profile: feed.cookie_profile,
          bilibili: {
            include_upower_exclusive: Boolean(feed.bilibili && feed.bilibili.include_upower_exclusive)
          },
          filters: {
            title: filters.title,
            not_title: filters.not_title,
            description: filters.description,
            not_description: filters.not_description,
            min_duration: filters.min_duration,
            max_duration: filters.max_duration,
            min_age: filters.min_age,
            max_age: filters.max_age
          }
        };
      }

      function setTextField(id, value) {
        byID(id).value = value === null || value === undefined ? "" : String(value);
      }

      function setCheckField(id, value) {
        byID(id).checked = Boolean(value);
      }

      var feedFormValidationFields = ["feed-id", "feed-url", "feed-update-period", "feed-page-size", "feed-keep-last"];

      function setFieldError(id, message) {
        var field = byID(id);
        var error = byID(id + "-error");
        var wrapper = field ? field.closest(".form-field") : null;
        if (!field || !error) return;
        error.textContent = message || "";
        field.setAttribute("aria-invalid", message ? "true" : "false");
        if (wrapper) wrapper.classList.toggle("has-error", Boolean(message));
      }

      function clearFeedFormErrors() {
        feedFormValidationFields.forEach(function (id) { setFieldError(id, ""); });
      }

      function focusFeedFormField(id) {
        var node = byID(id + "-trigger") || byID(id);
        if (node && typeof node.focus === "function") node.focus();
      }

      function validateRequiredTextField(id, label) {
        if (byID(id).value.trim() !== "") return true;
        setFieldError(id, "请填写" + label);
        return false;
      }

      function validateRequiredIntegerField(id, label, min) {
        var raw = byID(id).value.trim();
        if (raw === "") {
          setFieldError(id, "请填写" + label);
          return false;
        }
        if (!/^[0-9]+$/.test(raw)) {
          setFieldError(id, label + "必须是整数");
          return false;
        }
        var value = Number(raw);
        if (!Number.isSafeInteger(value) || value < min) {
          setFieldError(id, label + "不能小于 " + min);
          return false;
        }
        return true;
      }

      function validateFeedFormRequiredFields() {
        clearFeedFormErrors();
        var firstInvalid = "";
        function markInvalid(id, valid) {
          if (!valid && !firstInvalid) firstInvalid = id;
        }
        if (state.feedFormMode !== "edit") markInvalid("feed-id", validateRequiredTextField("feed-id", "订阅源 ID"));
        markInvalid("feed-url", validateRequiredTextField("feed-url", "来源 URL"));
        markInvalid("feed-update-period", validateRequiredTextField("feed-update-period", "更新周期"));
        markInvalid("feed-page-size", validateRequiredIntegerField("feed-page-size", "每页数量", 1));
        markInvalid("feed-keep-last", validateRequiredIntegerField("feed-keep-last", "保留最近", 0));
        if (firstInvalid) {
          focusFeedFormField(firstInvalid);
          return false;
        }
        return true;
      }

      function setFeedFormValues(feed) {
        var filters = feed.filters || emptyFilters();
        clearFeedFormErrors();
        setTextField("feed-id", feed.feed_id);
        setTextField("feed-provider", feed.provider);
        setTextField("feed-url", feed.url);
        setTextField("feed-title-override", feed.title_override);
        setTextField("feed-description-override", feed.description_override);
        setCheckField("feed-enabled", feed.enabled);
        setCheckField("feed-include-in-opml", feed.include_in_opml);
        setCheckField("feed-private-feed", feed.private_feed);
        setCheckField("feed-bilibili-include-upower", feed.bilibili && feed.bilibili.include_upower_exclusive);
        setTextField("feed-update-period", feed.update_period);
        setTextField("feed-page-size", feed.page_size);
        setTextField("feed-keep-last", feed.keep_last);
        setTextField("feed-cookie-profile", feed.cookie_profile);
        setTextField("feed-filter-title", filters.title);
        setTextField("feed-filter-not-title", filters.not_title);
        setTextField("feed-filter-description", filters.description);
        setTextField("feed-filter-not-description", filters.not_description);
        setTextField("feed-filter-min-duration", filters.min_duration);
        setTextField("feed-filter-max-duration", filters.max_duration);
        setTextField("feed-filter-min-age", filters.min_age);
        setTextField("feed-filter-max-age", filters.max_age);
      }

      function textOrNull(id) {
        var value = byID(id).value.trim();
        return value === "" ? null : value;
      }

      function requiredText(id, label) {
        var value = byID(id).value.trim();
        if (value === "") throw new Error(label + " 必填");
        return value;
      }

      function requiredInteger(id, label, min) {
        var raw = byID(id).value.trim();
        if (!/^[0-9]+$/.test(raw)) throw new Error(label + " 必须是整数");
        var value = Number(raw);
        if (!Number.isSafeInteger(value) || value < min) throw new Error(label + " 无效");
        return value;
      }

      function optionalInteger(id, label) {
        var raw = byID(id).value.trim();
        if (raw === "") return null;
        if (!/^[0-9]+$/.test(raw)) throw new Error(label + " 必须是整数");
        var value = Number(raw);
        if (!Number.isSafeInteger(value)) throw new Error(label + " 无效");
        return value;
      }

      function readFeedFormValues() {
        var feedID;
        var provider;
        if (state.feedFormMode === "edit") {
          var original = findFeedByID(state.editingFeedID);
          if (!original) throw new Error("原始订阅源不存在");
          feedID = state.editingFeedID;
          provider = original.provider;
        } else {
          feedID = requiredText("feed-id", "订阅源 ID");
          provider = byID("feed-provider").value;
        }
        if (provider !== "youtube" && provider !== "bilibili") throw new Error("平台无效");
        return {
          feed_id: feedID,
          provider: provider,
          url: requiredText("feed-url", "来源 URL"),
          title_override: textOrNull("feed-title-override"),
          description_override: textOrNull("feed-description-override"),
          enabled: byID("feed-enabled").checked,
          include_in_opml: byID("feed-include-in-opml").checked,
          private_feed: byID("feed-private-feed").checked,
          update_period: requiredText("feed-update-period", "更新周期"),
          page_size: requiredInteger("feed-page-size", "每页数量", 1),
          keep_last: requiredInteger("feed-keep-last", "保留最近", 0),
          cookie_profile: textOrNull("feed-cookie-profile"),
          bilibili: {
            include_upower_exclusive: provider === "bilibili" && byID("feed-bilibili-include-upower").checked
          },
          filters: {
            title: textOrNull("feed-filter-title"),
            not_title: textOrNull("feed-filter-not-title"),
            description: textOrNull("feed-filter-description"),
            not_description: textOrNull("feed-filter-not-description"),
            min_duration: optionalInteger("feed-filter-min-duration", "最小时长"),
            max_duration: optionalInteger("feed-filter-max-duration", "最大时长"),
            min_age: optionalInteger("feed-filter-min-age", "最短发布天数"),
            max_age: optionalInteger("feed-filter-max-age", "最长发布天数")
          }
        };
      }

      function renderFeedForm() {
        var form = byID("feed-form");
        byID("feed-modal").hidden = !state.feedFormOpen;
        form.hidden = !state.feedFormOpen;
        byID("feed-form-title").textContent = state.feedFormMode === "edit" ? "编辑订阅源" : "添加订阅源";
        byID("feed-form-subtitle").textContent = state.feedFormMode === "edit" ? state.editingFeedID : "配置远端订阅源，下次 NAS 同步时生效";
        var editing = state.feedFormMode === "edit";
        feedFormFieldIDs.forEach(function (id) { byID(id).disabled = state.busy; });
        byID("feed-id").readOnly = editing;
        byID("feed-provider").disabled = state.busy || editing;
        var isBilibili = byID("feed-provider").value === "bilibili";
        byID("feed-bilibili-options").hidden = !isBilibili;
        byID("feed-bilibili-include-upower").disabled = state.busy || !isBilibili;
        byID("feed-form-save").disabled = state.busy || !state.feedFormOpen;
        byID("feed-form-cancel").disabled = state.busy;
        byID("feed-danger-zone").hidden = !editing;
        syncCustomSelect("feed-provider");
        syncModalScrollLock();
      }

      function openNewFeedForm() {
        state.feedFormOpen = true;
        state.feedFormMode = "create";
        state.editingFeedID = "";
        setFeedFormValues(defaultFeedFormValues());
        renderFeedForm();
        setStatus("正在添加订阅源");
      }

      function openEditFeedForm(feedID) {
        var feed = findFeedByID(feedID);
        if (!feed) {
          showError("订阅源不存在");
          return;
        }
        state.feedFormOpen = true;
        state.feedFormMode = "edit";
        state.editingFeedID = feed.feed_id;
        setFeedFormValues(feedFormValuesFromFeed(feed));
        renderFeedForm();
        setStatus("正在编辑 " + feed.feed_id);
      }

      function closeFeedForm() {
        state.feedFormOpen = false;
        state.feedFormMode = "create";
        state.editingFeedID = "";
        renderFeedForm();
      }

      function providerLabel(provider) {
        return provider === "bilibili" ? "B 站" : "YouTube";
      }

      function providerPillClass(provider) {
        return "pill " + (provider === "bilibili" ? "provider-bilibili" : "provider-youtube");
      }

      function feedAvatar(feed) {
        var label = feed.provider === "bilibili" ? "B" : "Y";
        var avatar = el("span", "feed-avatar", label);
        var url = safeImageURL(feed.image_url);
        if (!url) return avatar;
        avatar.textContent = "";
        var image = document.createElement("img");
        image.src = url;
        image.alt = (feed.title || feed.feed_id) + " 头像";
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        image.addEventListener("error", function () {
          avatar.replaceChildren(label);
        }, { once: true });
        avatar.appendChild(image);
        return avatar;
      }

      function needsCookie(feed) {
        return feed.provider === "bilibili" && !feed.cookie_profile;
      }

      function feedState(feed) {
        if (!feed.enabled) return { label: "已停用", className: "disabled" };
        if (needsCookie(feed)) return { label: "需要 Cookie", className: "warning" };
        return { label: "已启用", className: "success" };
      }

      function feedLastUpdated(feed) {
        if (feed.latest_episode_published_at) return formatRelative(feed.latest_episode_published_at);
        return "-";
      }

      function feedLastUpdatedTime(feed) {
        if (!feed.latest_episode_published_at) return 0;
        var time = new Date(feed.latest_episode_published_at).getTime();
        return Number.isNaN(time) ? 0 : time;
      }

      function iconButton(className, label, icon) {
        var button = el("button", "icon-button " + className);
        button.type = "button";
        button.setAttribute("aria-label", label);
        button.setAttribute("data-tooltip", label);
        button.appendChild(iconSVG(icon));
        return button;
      }

      function iconSVG(name) {
        var svgNS = "http" + "://www.w3.org/2000/svg";
        var svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        function path(d) {
          var node = document.createElementNS(svgNS, "path");
          node.setAttribute("d", d);
          svg.appendChild(node);
        }
        function line(x1, y1, x2, y2) {
          var node = document.createElementNS(svgNS, "line");
          node.setAttribute("x1", x1);
          node.setAttribute("y1", y1);
          node.setAttribute("x2", x2);
          node.setAttribute("y2", y2);
          svg.appendChild(node);
        }
        if (name === "pause") {
          line("8", "5", "8", "19");
          line("16", "5", "16", "19");
        } else if (name === "play") {
          path("M8 5v14l11-7z");
        } else if (name === "edit") {
          path("M12 20h9");
          path("M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z");
        } else if (name === "copy") {
          path("M8 8h11v11H8z");
          path("M5 16H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1");
        } else if (name === "list") {
          line("8", "6", "21", "6");
          line("8", "12", "21", "12");
          line("8", "18", "21", "18");
          line("3", "6", "3.01", "6");
          line("3", "12", "3.01", "12");
          line("3", "18", "3.01", "18");
        } else if (name === "hide") {
          path("M3 3l18 18");
          path("M10.6 10.6a2 2 0 0 0 2.8 2.8");
          path("M9.9 4.2A10.9 10.9 0 0 1 12 4c5 0 9 5 9 5a17.8 17.8 0 0 1-3.2 3.8");
          path("M6.6 6.6C4.4 8 3 10 3 10s4 5 9 5c1.1 0 2.1-.2 3.1-.5");
        } else if (name === "restore") {
          path("M3 12a9 9 0 1 0 3-6.7");
          path("M3 4v6h6");
        } else {
          path("M3 6h18");
          path("M8 6V4h8v2");
          path("M6 6l1 14h10l1-14");
          line("10", "11", "10", "17");
          line("14", "11", "14", "17");
        }
        return svg;
      }

      function feedSortText(value) {
        return String(value || "").toLocaleLowerCase();
      }

      function feedSortValue(feed, key) {
        if (key === "provider") return providerLabel(feed.provider);
        if (key === "status") return feedState(feed).label;
        if (key === "last_updated") return feedLastUpdatedTime(feed);
        if (key === "episodes") return Number(feed.episode_count || 0);
        if (key === "subscription") return feed.public_feed_url ? 1 : 0;
        return feed.title || feed.feed_id;
      }

      function compareFeedSortValues(left, right, key, direction) {
        var leftValue = feedSortValue(left, key);
        var rightValue = feedSortValue(right, key);
        if (key === "last_updated") {
          if (!leftValue && !rightValue) return feedSortText(left.title || left.feed_id).localeCompare(feedSortText(right.title || right.feed_id));
          if (!leftValue) return 1;
          if (!rightValue) return -1;
        }
        var result;
        if (typeof leftValue === "number" && typeof rightValue === "number") {
          result = leftValue === rightValue ? 0 : (leftValue < rightValue ? -1 : 1);
        } else {
          result = feedSortText(leftValue).localeCompare(feedSortText(rightValue));
        }
        if (result === 0) result = feedSortText(left.title || left.feed_id).localeCompare(feedSortText(right.title || right.feed_id));
        return direction === "desc" ? -result : result;
      }

      function sortedFeeds(feeds) {
        return feeds.slice().sort(function (left, right) {
          return compareFeedSortValues(left, right, state.feedSortKey, state.feedSortDirection);
        });
      }

      function defaultSortDirection(key) {
        return key === "last_updated" || key === "episodes" || key === "subscription" ? "desc" : "asc";
      }

      function setFeedSort(key) {
        if (state.feedSortKey === key) {
          state.feedSortDirection = state.feedSortDirection === "asc" ? "desc" : "asc";
        } else {
          state.feedSortKey = key;
          state.feedSortDirection = defaultSortDirection(key);
        }
        renderFeeds();
      }

      function renderFeedSortHeaders() {
        document.querySelectorAll("[data-sort-key]").forEach(function (button) {
          var key = button.getAttribute("data-sort-key");
          var active = key === state.feedSortKey;
          var direction = active ? state.feedSortDirection : "";
          button.classList.toggle("active", active);
          button.classList.toggle("asc", direction === "asc");
          button.classList.toggle("desc", direction === "desc");
          button.querySelector(".sort-indicator").textContent = active ? (direction === "asc" ? "↑" : "↓") : "";
          var header = button.closest("th");
          if (header) header.setAttribute("aria-sort", active ? (direction === "asc" ? "ascending" : "descending") : "none");
        });
      }

      function filteredFeeds() {
        return state.feeds.filter(function (feed) {
          var text = [feed.feed_id, feed.title, feed.url, feed.cookie_profile].filter(Boolean).join(" ").toLowerCase();
          if (state.feedSearch && text.indexOf(state.feedSearch.toLowerCase()) === -1) return false;
          if (state.providerFilter && feed.provider !== state.providerFilter) return false;
          if (state.feedStateFilter === "enabled" && !feed.enabled) return false;
          if (state.feedStateFilter === "disabled" && feed.enabled) return false;
          if (state.feedStateFilter === "needs_cookie" && !needsCookie(feed)) return false;
          return true;
        });
      }

      function renderSummary() {
        var enabled = state.feeds.filter(function (feed) { return feed.enabled; }).length;
        var latest = state.syncRuns[0];
        var latestEvent = state.events[0];
        var lastContact = latestEvent ? latestEvent.event_time : (latest ? latest.finished_at || latest.started_at : "");
        byID("metric-feeds").textContent = String(state.feeds.length);
        byID("metric-enabled").textContent = String(enabled);
        byID("metric-logs").textContent = String(state.events.length);
        byID("logs-subtitle").textContent = "最近 NAS 联系：" + formatRelative(lastContact);
      }

      function renderFeeds() {
        var body = byID("feeds-body");
        body.replaceChildren();
        renderFeedSortHeaders();
        var feeds = sortedFeeds(filteredFeeds());
        if (state.feeds.length === 0) {
          body.appendChild(emptyRow(7, "还没有订阅源。"));
          return;
        }
        if (feeds.length === 0) {
          body.appendChild(emptyRow(7, "没有匹配的订阅源。"));
          return;
        }
        feeds.forEach(function (feed) {
          var row = el("tr", (feed.feed_id === state.selectedFeedID ? "selected " : "") + (!feed.enabled ? "disabled-row" : ""));
          var provider = providerLabel(feed.provider);
          var status = feedState(feed);
          var lastUpdated = feedLastUpdated(feed);
          var name = el("button", "ghost feed-title-button", feed.title || feed.feed_id);
          name.type = "button";
          name.title = feed.url || feed.feed_id;
          name.addEventListener("click", function () { openFeedDetailsModal(feed.feed_id); });
          var nameStack = el("div", "stack feed-name-stack");
          nameStack.appendChild(feedAvatar(feed));
          nameStack.appendChild(name);
          var mobileMeta = el("div", "mobile-feed-meta");
          mobileMeta.appendChild(el("span", providerPillClass(feed.provider), provider));
          mobileMeta.appendChild(el("span", "pill " + status.className, status.label));
          mobileMeta.appendChild(el("span", "pill", lastUpdated));
          nameStack.appendChild(mobileMeta);
          appendCell(row, nameStack, "", "订阅源");
          appendCell(row, el("span", providerPillClass(feed.provider), provider), "provider-cell", "平台");
          appendCell(row, el("span", "pill " + status.className, status.label), "status-cell", "状态");
          appendCell(row, lastUpdated, "activity-cell", "最近更新");
          var episodeLabel = "查看(" + Number(feed.episode_count || 0) + ")";
          var episodes = el("button", "small", episodeLabel);
          episodes.type = "button";
          episodes.addEventListener("click", function () { openEpisodesModal(feed.feed_id); });
          appendCell(row, episodes, "episodes-cell", "剧集");
          var copy = el("button", "small", "复制");
          copy.type = "button";
          copy.disabled = !feed.public_feed_url;
          copy.title = feed.public_feed_url || "暂无公开订阅地址";
          copy.addEventListener("click", function () { copyText(feed.public_feed_url); });
          appendCell(row, copy, "subscription-cell", "订阅");
          var actions = el("div", "actions");
          var mobileEpisodes = iconButton("list mobile-only", episodeLabel, "list");
          mobileEpisodes.disabled = state.busy;
          mobileEpisodes.addEventListener("click", function () { openEpisodesModal(feed.feed_id); });
          actions.appendChild(mobileEpisodes);
          var mobileCopy = iconButton("copy mobile-only", "复制订阅地址", "copy");
          mobileCopy.disabled = state.busy || !feed.public_feed_url;
          mobileCopy.setAttribute("data-tooltip", feed.public_feed_url ? "复制订阅地址" : "暂无公开订阅地址");
          mobileCopy.addEventListener("click", function () { copyText(feed.public_feed_url); });
          actions.appendChild(mobileCopy);
          var toggle = iconButton(feed.enabled ? "pause" : "play", feed.enabled ? "停用订阅源" : "启用订阅源", feed.enabled ? "pause" : "play");
          toggle.disabled = state.busy;
          toggle.addEventListener("click", function () { updateFeedStatus(feed.feed_id, { enabled: !feed.enabled }); });
          actions.appendChild(toggle);
          var edit = iconButton("edit", "编辑订阅源", "edit");
          edit.disabled = state.busy;
          edit.addEventListener("click", function () { openEditFeedForm(feed.feed_id); });
          actions.appendChild(edit);
          var del = iconButton("delete", "删除订阅源", "delete");
          del.disabled = state.busy;
          del.setAttribute("data-tooltip", "删除订阅源");
          del.setAttribute("aria-label", "删除订阅源");
          del.addEventListener("click", function () { deleteFeed(feed.feed_id); });
          actions.appendChild(del);
          appendCell(row, actions, "actions-cell", "操作");
          body.appendChild(row);
        });
      }

      function renderFeedDetails() {
        var modal = byID("feed-details-modal");
        var body = byID("feed-details-body");
        modal.hidden = !state.feedDetailsOpen;
        if (!state.feedDetailsOpen) return;
        body.replaceChildren();
        var feed = findFeedByID(state.detailsFeedID);
        if (!feed) {
          byID("feed-details-title").textContent = "订阅源信息";
          byID("feed-details-subtitle").textContent = "订阅源不存在";
          byID("feed-details-footer").textContent = "-";
          body.appendChild(el("div", "empty", "订阅源不存在或已被删除。"));
          return;
        }

        byID("feed-details-title").textContent = feed.title || feed.feed_id;
        byID("feed-details-subtitle").textContent = feed.feed_id;
        byID("feed-details-footer").textContent = "最近更新：" + feedLastUpdated(feed);

        var chips = el("div", "detail-chips");
        chips.appendChild(el("span", providerPillClass(feed.provider), providerLabel(feed.provider)));
        var status = feedState(feed);
        chips.appendChild(el("span", "pill " + status.className, status.label));
        if (feed.include_in_opml) chips.appendChild(el("span", "pill success", "OPML"));
        if (feed.private_feed) chips.appendChild(el("span", "pill", "私密"));
        if (feed.cookie_profile) chips.appendChild(el("span", "pill", "Cookie"));
        if (feed.bilibili && feed.bilibili.include_upower_exclusive) chips.appendChild(el("span", "pill success", "UP 主专属"));
        body.appendChild(chips);

        var grid = el("dl", "detail-grid");
        appendDetailItem(grid, "来源 URL", linkValue(feed.url), true);
        appendDetailItem(grid, "订阅 URL", linkValue(feed.public_feed_url), true);
        appendDetailItem(grid, "平台", providerLabel(feed.provider));
        appendDetailItem(grid, "状态", status.label);
        appendDetailItem(grid, "更新周期", feed.update_period);
        appendDetailItem(grid, "每页数量", feed.page_size);
        appendDetailItem(grid, "保留最近", feed.keep_last);
        appendDetailItem(grid, "Cookie 配置", feed.cookie_profile);
        appendDetailItem(grid, "加入 OPML", formatBoolean(feed.include_in_opml));
        appendDetailItem(grid, "私密订阅", formatBoolean(feed.private_feed));
        appendDetailItem(grid, "UP 主专属", formatBoolean(feed.bilibili && feed.bilibili.include_upower_exclusive));
        appendDetailItem(grid, "最近更新", feedLastUpdated(feed));
        appendDetailItem(grid, "标题覆盖", feed.title_override, true);
        appendDetailItem(grid, "描述", feed.description || feed.description_override, true);
        appendDetailItem(grid, "过滤条件", feedFilterSummary(feed), true);
        body.appendChild(grid);
      }

      function episodeStatusLabel(status) {
        var labels = { pending: "待处理", visible: "已发布", hidden: "已隐藏", delete_pending: "等待删除", purged: "已清理" };
        return labels[status] || status;
      }

      function filteredEpisodes() {
        return state.episodes.filter(function (episode) {
          var text = [episode.title, episode.local_episode_id, episode.source_episode_id].filter(Boolean).join(" ").toLowerCase();
          if (state.episodeSearch && text.indexOf(state.episodeSearch.toLowerCase()) === -1) return false;
          return true;
        });
      }

      function renderEpisodes() {
        var body = byID("episodes-body");
        body.replaceChildren();
        if (!state.selectedFeedID) {
          body.appendChild(emptyRow(6, "选择订阅源后查看剧集。"));
          return;
        }
        var feed = findFeedByID(state.selectedFeedID);
        byID("episodes-subtitle").textContent = (feed ? (feed.title || feed.feed_id) : state.selectedFeedID) + " · " + state.episodes.length + " 个剧集";
        var episodes = filteredEpisodes();
        byID("episodes-pagination").textContent = episodes.length ? "1-" + episodes.length + " / " + state.episodes.length : "0 / " + state.episodes.length;
        if (state.episodes.length === 0) {
          body.appendChild(emptyRow(6, "这个订阅源还没有同步到剧集。"));
          return;
        }
        if (episodes.length === 0) {
          body.appendChild(emptyRow(6, "没有匹配的剧集。"));
          return;
        }
        episodes.forEach(function (episode) {
          var row = el("tr");
          var title = episode.title || episode.local_episode_id;
          var safeSourceURL = safeExternalURL(episode.source_url);
          var titleNode;
          if (safeSourceURL) {
            titleNode = el("a", "episode-title-link", title);
            titleNode.href = safeSourceURL;
            titleNode.rel = "noopener noreferrer";
            titleNode.target = "_blank";
          } else {
            titleNode = el("span", "episode-title-link", title);
          }
          appendCell(row, titleNode, "episode-title-cell", "剧集");
          appendCell(row, formatDate(episode.published_at || episode.updated_at), "episode-published-cell", "发布");
          appendCell(row, formatDuration(episode.duration), "episode-duration-cell", "时长");
          appendCell(row, episode.has_media ? formatBytes(episode.size) : "-", "episode-size-cell", "大小");
          appendCell(row, el("span", "pill " + episode.status, episodeStatusLabel(episode.status)), "episode-status-cell", "状态");
          appendCell(row, episodeActions(episode), "actions-cell", "操作");
          body.appendChild(row);
        });
      }

      function episodeActions(episode) {
        var actions = el("div", "actions");
        var list = [];
        if (episode.source_url) list.push(["copy", "复制"]);
        if (episode.status === "pending" || episode.status === "visible") {
          list.push(["hide", "隐藏"]);
          list.push(["delete", "删除"]);
        } else if (episode.status === "hidden") {
          list.push(["restore", "恢复"]);
          list.push(["delete", "删除"]);
        } else if (episode.status === "delete_pending") {
          list.push(["restore", "恢复"]);
        }
        if (list.length === 0) {
          actions.appendChild(el("span", "muted", "无操作"));
          return actions;
        }
        list.forEach(function (item) {
          var action = item[0];
          var label = item[1];
          var button = iconButton(action, label, action);
          if (action === "delete") button.setAttribute("data-tooltip", "删除远端剧集");
          button.disabled = state.busy;
          button.addEventListener("click", function () {
            if (action === "copy") {
              copyText(episode.source_url);
              return;
            }
            updateEpisodeStatus(episode.local_episode_id, action);
          });
          actions.appendChild(button);
        });
        return actions;
      }

      function renderUrlList(container, rows, labelField) {
        container.replaceChildren();
        if (!rows.length) {
          container.appendChild(el("div", "empty", "暂无地址。"));
          return;
        }
        rows.forEach(function (row) {
          var wrapper = el("div", "url-row");
          var stack = el("div", "stack");
          stack.appendChild(el("span", "", row.title || row[labelField] || "订阅地址"));
          stack.appendChild(el("span", "mono muted", row.xml_url));
          var button = el("button", "", "复制");
          button.type = "button";
          button.addEventListener("click", function () { copyText(row.xml_url); });
          wrapper.appendChild(stack);
          wrapper.appendChild(button);
          container.appendChild(wrapper);
        });
      }

      function renderSubscriptions() {
        renderUrlList(byID("subscription-feeds"), state.subscriptions.feeds || [], "feed_id");
        renderUrlList(byID("subscription-opml"), state.subscriptions.opml || [], "label");
      }

      function renderRuns() {
        var body = byID("runs-body");
        body.replaceChildren();
        if (!state.syncRuns.length) {
          body.appendChild(emptyRow(3, "暂无同步记录。"));
          return;
        }
        state.syncRuns.forEach(function (run) {
          var row = el("tr");
          var runStack = el("div", "stack");
          runStack.appendChild(el("span", "mono", run.id));
          runStack.appendChild(el("span", "muted", formatDate(run.started_at)));
          appendCell(row, runStack);
          appendCell(row, el("span", "pill " + run.status, run.status));
          appendCell(row, "订阅源 " + run.feeds_updated + " / 下载 " + run.episodes_downloaded + " / 上传 " + run.episodes_uploaded + " / 错误 " + run.errors_count);
          body.appendChild(row);
        });
      }

      function levelClass(level) {
        if (level === "error") return "danger";
        if (level === "warning" || level === "warn") return "warning";
        if (level === "success") return "success";
        return "info";
      }

      function levelLabel(level) {
        if (level === "error") return "错误";
        if (level === "warning" || level === "warn") return "警告";
        if (level === "success") return "成功";
        return "信息";
      }

      function eventMatchesLevel(event, selectedLevel) {
        if (!selectedLevel) return true;
        if (selectedLevel === "warning") return event.level === "warning" || event.level === "warn";
        return event.level === selectedLevel;
      }

      function renderEvents() {
        var body = byID("events-body");
        body.replaceChildren();
        var events = state.events.filter(function (event) { return eventMatchesLevel(event, state.eventLevelFilter); });
        byID("logs-empty-filter").hidden = events.length > 0 || !state.eventLevelFilter;
        if (!events.length) {
          body.appendChild(emptyRow(4, state.eventLevelFilter ? "没有匹配的日志。" : "暂无运行日志。"));
          return;
        }
        events.forEach(function (event) {
          var row = el("tr");
          appendCell(row, formatDate(event.event_time));
          appendCell(row, el("span", "pill " + levelClass(event.level), levelLabel(event.level)));
          appendCell(row, event.feed_id || event.type || "-");
          appendCell(row, event.error_detail || event.message || event.error_code || formatDate(event.event_time));
          body.appendChild(row);
        });
      }

      function renderAll() {
        renderSummary();
        renderFeeds();
        renderFeedDetails();
        renderFeedForm();
        renderEpisodes();
        renderSubscriptions();
        renderRuns();
        renderEvents();
        syncModalScrollLock();
      }

      function syncModalScrollLock() {
        var hasOpenModal = Array.prototype.some.call(document.querySelectorAll(".modal-backdrop"), function (modal) {
          return !modal.hidden;
        });
        document.body.classList.toggle("modal-open", hasOpenModal);
      }

      async function loadDashboard() {
        setBusy(true);
        setStatus("加载中...");
        try {
          var results = await Promise.all([
            api(paths.feeds),
            api(paths.subscriptions),
            api(paths.syncRuns),
            api(paths.events)
          ]);
          state.feeds = results[0].feeds || [];
          state.subscriptions = results[1] || { feeds: [], opml: [] };
          state.syncRuns = results[2].sync_runs || [];
          state.events = results[3].events || [];
          if (!state.selectedFeedID && state.feeds.length > 0) state.selectedFeedID = state.feeds[0].feed_id;
          if (state.selectedFeedID && !state.feeds.some(function (feed) { return feed.feed_id === state.selectedFeedID; })) {
            state.selectedFeedID = state.feeds.length > 0 ? state.feeds[0].feed_id : "";
          }
          await loadEpisodes(false);
          setStatus("已更新 " + new Date().toLocaleTimeString(), "ok");
        } catch (error) {
          showError(error);
          renderAll();
        } finally {
          setBusy(false);
        }
      }

      async function loadEpisodes(showLoading) {
        if (!state.selectedFeedID) {
          state.episodes = [];
          renderAll();
          return;
        }
        if (showLoading) setStatus("正在加载剧集...");
        var query = "?feed_id=" + encodeURIComponent(state.selectedFeedID) + "&limit=50";
        if (state.episodeStatus) query += "&status=" + encodeURIComponent(state.episodeStatus);
        try {
          var result = await api(paths.episodes + query);
          state.episodes = result.episodes || [];
          renderAll();
          if (showLoading) setStatus("剧集已加载", "ok");
        } catch (error) {
          showError(error);
        }
      }

      function selectFeed(feedID) {
        state.selectedFeedID = feedID;
        state.episodes = [];
        renderAll();
        loadEpisodes(true);
      }

      function openEpisodesModal(feedID) {
        state.selectedFeedID = feedID;
        state.episodeStatus = "";
        state.episodeSearch = "";
        byID("episode-status-filter").value = "";
        byID("episode-search").value = "";
        syncCustomSelect("episode-status-filter");
        byID("episodes-modal").hidden = false;
        syncModalScrollLock();
        selectFeed(feedID);
      }

      function openFeedDetailsModal(feedID) {
        state.detailsFeedID = feedID;
        state.feedDetailsOpen = true;
        renderFeedDetails();
        syncModalScrollLock();
      }

      function closeFeedDetailsModal() {
        state.feedDetailsOpen = false;
        state.detailsFeedID = "";
        renderFeedDetails();
        syncModalScrollLock();
      }

      function closeEpisodesModal() {
        byID("episodes-modal").hidden = true;
        syncModalScrollLock();
      }
      function openLogsModal() {
        byID("logs-modal").hidden = false;
        renderEvents();
        syncModalScrollLock();
      }
      function closeLogsModal() {
        byID("logs-modal").hidden = true;
        syncModalScrollLock();
      }

      async function submitFeedForm(event) {
        event.preventDefault();
        if (!validateFeedFormRequiredFields()) {
          showError("请先填写必填项");
          return;
        }
        var payload;
        try {
          payload = readFeedFormValues();
          clearFeedFormErrors();
        } catch (error) {
          if (String(error && error.message || error).indexOf("URL") >= 0) {
            setFieldError("feed-url", "请输入有效的 B 站空间或 YouTube 地址。");
            focusFeedFormField("feed-url");
          }
          showError(error);
          return;
        }
        setBusy(true);
        renderFeedForm();
        try {
          var result = await postJSON(paths.feedUpsert, payload);
          var saved = result.feed || payload;
          state.selectedFeedID = saved.feed_id;
          state.feedFormOpen = false;
          state.feedFormMode = "create";
          state.editingFeedID = "";
          await loadDashboard();
          setStatus("已保存订阅源 " + saved.feed_id, "ok");
          showToast("订阅源已保存", "success");
        } catch (error) {
          showError(error);
        } finally {
          setBusy(false);
          renderFeedForm();
        }
      }

      async function updateFeedStatus(feedID, patch) {
        setBusy(true);
        try {
          await postJSON(paths.feedStatus, Object.assign({ feed_id: feedID }, patch));
          await loadDashboard();
          showToast("订阅源状态已更新", "success");
        } catch (error) {
          showError(error);
        } finally {
          setBusy(false);
        }
      }

      function deleteFeed(feedID) {
        openConfirmDialog({
          title: "删除订阅源？",
          message: "这会从远端配置、RSS 和 OPML 中移除 " + feedID + "，并标记相关 R2 媒体等待清理。不会删除 NAS 本地文件。",
          label: "删除",
          danger: true,
          onConfirm: function () { performDeleteFeed(feedID); }
        });
      }

      async function performDeleteFeed(feedID) {
        setBusy(true);
        try {
          await postJSON(paths.feedDelete, { feed_id: feedID });
          if (state.selectedFeedID === feedID) {
            state.selectedFeedID = "";
            state.episodes = [];
          }
          await loadDashboard();
          setStatus("已删除订阅源 " + feedID, "ok");
          showToast("订阅源已删除", "success");
        } catch (error) {
          showError(error);
        } finally {
          setBusy(false);
        }
      }

      function updateEpisodeStatus(localEpisodeID, action) {
        if (!state.selectedFeedID) return;
        if (action === "delete") {
          openConfirmDialog({
            title: "删除远端剧集？",
            message: "远端 RSS 会立即隐藏该剧集，并安排 R2 媒体稍后清理。不会删除 NAS 本地文件。",
            label: "删除",
            danger: true,
            onConfirm: function () { performEpisodeStatusUpdate(localEpisodeID, action); }
          });
          return;
        }
        performEpisodeStatusUpdate(localEpisodeID, action);
      }

      async function performEpisodeStatusUpdate(localEpisodeID, action) {
        setBusy(true);
        try {
          await postJSON(paths.episodeStatus, {
            feed_id: state.selectedFeedID,
            local_episode_id: localEpisodeID,
            action: action
          });
          await loadEpisodes(true);
          showToast("剧集状态已更新", "success");
        } catch (error) {
          showError(error);
        } finally {
          setBusy(false);
        }
      }

      function openConfirmDialog(options) {
        state.confirmAction = options.onConfirm;
        byID("confirm-title").textContent = options.title;
        byID("confirm-message").textContent = options.message;
        byID("confirm-ok").textContent = options.label || "确认";
        byID("confirm-ok").className = options.danger ? "danger" : "primary";
        byID("confirm-modal").hidden = false;
        syncModalScrollLock();
      }

      function closeConfirmDialog() {
        state.confirmAction = null;
        byID("confirm-modal").hidden = true;
        syncModalScrollLock();
      }

      function closeModalFromBackdrop(event) {
        if (event.target !== event.currentTarget) return;
        closeCustomSelects("");
        var modalID = event.currentTarget.id;
        if (modalID === "feed-modal") closeFeedForm();
        if (modalID === "feed-details-modal") closeFeedDetailsModal();
        if (modalID === "episodes-modal") closeEpisodesModal();
        if (modalID === "logs-modal") closeLogsModal();
        if (modalID === "confirm-modal") closeConfirmDialog();
      }

      function runConfirmAction() {
        var action = state.confirmAction;
        closeConfirmDialog();
        if (action) action();
      }

      function copyOpmlURL() {
        var rows = state.subscriptions.opml || [];
        if (!rows.length) {
          showToast("暂无 OPML 地址", "warning");
          return;
        }
        copyText(rows[0].xml_url);
      }

      function copyLogs() {
        var text = state.events.map(function (event) {
          return [formatDate(event.event_time), levelLabel(event.level), event.feed_id || event.type || "-", event.error_detail || event.message || event.error_code || ""].join(" | ");
        }).join("\\n");
        copyText(text);
      }

      function syncCustomSelect(selectID) {
        var select = byID(selectID);
        var trigger = byID(selectID + "-trigger");
        var menu = byID(selectID + "-menu");
        if (!select || !trigger || !menu) return;
        var selected = select.options[select.selectedIndex];
        trigger.textContent = selected ? selected.textContent : "";
        trigger.disabled = select.disabled;
        trigger.setAttribute("aria-disabled", select.disabled ? "true" : "false");
        if (select.disabled) {
          menu.hidden = true;
          trigger.setAttribute("aria-expanded", "false");
        }
        var control = document.querySelector('[data-select-control="' + selectID + '"]');
        if (control) control.classList.toggle("is-disabled", select.disabled);
        Array.prototype.forEach.call(menu.querySelectorAll("[data-select-value]"), function (option) {
          option.setAttribute("aria-selected", option.getAttribute("data-select-value") === select.value ? "true" : "false");
        });
      }

      function closeCustomSelects(exceptID) {
        Array.prototype.forEach.call(document.querySelectorAll("[data-select-control]"), function (control) {
          var selectID = control.getAttribute("data-select-control");
          if (!selectID || selectID === exceptID) return;
          var trigger = byID(selectID + "-trigger");
          var menu = byID(selectID + "-menu");
          if (menu) menu.hidden = true;
          if (trigger) trigger.setAttribute("aria-expanded", "false");
        });
      }

      function setupCustomSelect(selectID) {
        var select = byID(selectID);
        var trigger = byID(selectID + "-trigger");
        var menu = byID(selectID + "-menu");
        if (!select || !trigger || !menu) return;
        trigger.addEventListener("click", function (event) {
          event.stopPropagation();
          if (select.disabled) return;
          var willOpen = menu.hidden;
          closeCustomSelects(selectID);
          menu.hidden = !willOpen;
          trigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
          if (willOpen) {
            var selectedOption = menu.querySelector('[aria-selected="true"]');
            if (selectedOption) selectedOption.focus();
          }
        });
        Array.prototype.forEach.call(menu.querySelectorAll("[data-select-value]"), function (option) {
          option.addEventListener("click", function (event) {
            event.stopPropagation();
            select.value = option.getAttribute("data-select-value") || "";
            select.dispatchEvent(new Event("change", { bubbles: true }));
            closeCustomSelects("");
            trigger.focus();
          });
        });
        select.addEventListener("change", function () { syncCustomSelect(selectID); });
        syncCustomSelect(selectID);
      }

      byID("new-feed").addEventListener("click", openNewFeedForm);
      byID("feed-form").addEventListener("submit", submitFeedForm);
      byID("feed-form-cancel").addEventListener("click", closeFeedForm);
      byID("feed-form-close").addEventListener("click", closeFeedForm);
      byID("feed-provider").addEventListener("change", renderFeedForm);
      feedFormValidationFields.forEach(function (id) {
        byID(id).addEventListener("input", function () { setFieldError(id, ""); });
      });
      byID("feed-details-close").addEventListener("click", closeFeedDetailsModal);
      byID("feed-details-footer-close").addEventListener("click", closeFeedDetailsModal);
      byID("refresh-episodes").addEventListener("click", function () { loadEpisodes(true); });
      byID("episode-status-filter").addEventListener("change", function (event) { state.episodeStatus = event.target.value; loadEpisodes(true); });
      byID("episode-search").addEventListener("input", function (event) { state.episodeSearch = event.target.value; renderEpisodes(); });
      byID("episodes-close").addEventListener("click", closeEpisodesModal);
      byID("episodes-footer-close").addEventListener("click", closeEpisodesModal);
      byID("open-logs").addEventListener("click", openLogsModal);
      byID("logs-footer-close").addEventListener("click", closeLogsModal);
      byID("refresh-logs").addEventListener("click", loadDashboard);
      byID("copy-logs").addEventListener("click", copyLogs);
      byID("event-level-filter").addEventListener("change", function (event) { state.eventLevelFilter = event.target.value; renderEvents(); });
      byID("reset-event-filter").addEventListener("click", function () {
        state.eventLevelFilter = "";
        byID("event-level-filter").value = "";
        syncCustomSelect("event-level-filter");
        renderEvents();
      });
      byID("feed-search").addEventListener("input", function (event) { state.feedSearch = event.target.value; renderFeeds(); });
      byID("provider-filter").addEventListener("change", function (event) { state.providerFilter = event.target.value; renderFeeds(); });
      byID("feed-state-filter").addEventListener("change", function (event) { state.feedStateFilter = event.target.value; renderFeeds(); });
      document.querySelectorAll("[data-sort-key]").forEach(function (button) {
        button.addEventListener("click", function () { setFeedSort(button.getAttribute("data-sort-key")); });
      });
      byID("reset-feed-filters").addEventListener("click", function () {
        state.feedSearch = "";
        state.providerFilter = "";
        state.feedStateFilter = "";
        byID("feed-search").value = "";
        byID("provider-filter").value = "";
        byID("feed-state-filter").value = "";
        syncCustomSelect("provider-filter");
        syncCustomSelect("feed-state-filter");
        renderFeeds();
      });
      byID("copy-opml").addEventListener("click", copyOpmlURL);
      byID("feed-modal-disable").addEventListener("click", function () { if (state.editingFeedID) updateFeedStatus(state.editingFeedID, { enabled: false }); });
      byID("feed-modal-delete").addEventListener("click", function () { if (state.editingFeedID) deleteFeed(state.editingFeedID); });
      byID("confirm-cancel").addEventListener("click", closeConfirmDialog);
      byID("confirm-close").addEventListener("click", closeConfirmDialog);
      byID("confirm-ok").addEventListener("click", runConfirmAction);
      Array.prototype.forEach.call(document.querySelectorAll(".modal-backdrop"), function (backdrop) {
        backdrop.addEventListener("click", closeModalFromBackdrop);
      });
      document.addEventListener("keydown", function (event) {
        if (event.key !== "Escape") return;
        closeCustomSelects("");
        closeConfirmDialog();
        closeLogsModal();
        closeEpisodesModal();
        closeFeedDetailsModal();
        closeFeedForm();
      });
      document.addEventListener("click", function (event) {
        var target = event.target;
        if (target && target.closest && target.closest("[data-select-control]")) return;
        closeCustomSelects("");
      });
      setupCustomSelect("provider-filter");
      setupCustomSelect("feed-state-filter");
      setupCustomSelect("feed-provider");
      setupCustomSelect("episode-status-filter");
      setupCustomSelect("event-level-filter");

      loadDashboard();
    }());
  </script>
</body>
</html>`;
}

export function dashboardResponse(): Response {
  return new Response(dashboardHTML(), {
    status: 200,
    headers: dashboardHeaders(),
  });
}
