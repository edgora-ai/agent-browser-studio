// DB tab — browse the agent's SQLite tables + run SQL.
(function() {
  "use strict";
  var agentBrowser = window.agentBrowser;

  // R190: reads went straight to api.* — no timeout, so a hung main process
  // left this tab on "Loading…" forever. ipc.call has a per-kind budget.
  function lcall(key, fn) {
    return agentBrowser.ipc.call(key, fn, { kind: "list" });
  }
  var api = agentBrowser.api;
  var helpers = agentBrowser.helpers;
  var toast = helpers.toast;
  var esc = helpers.esc;
  var escAttr = helpers.escAttr;

  var icon = helpers.icon;
  function t(key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; }

  agentBrowser.loadDbTab = function() {
    lcall("agentDb.tables", function () { return api.agentDb.tables(); }).then(function(tables) {
      var el = document.getElementById("db-tables");
      if (!tables || tables.length === 0) {
        el.innerHTML = '<div style="color:var(--text-muted);padding:8px;">' + t("db.empty-tables","还没有表。让 Agent 建一个,或在 SQL 框跑 <code>CREATE TABLE ...</code>。") + '</div>';
        return;
      }
      el.innerHTML = tables.map(function(tbl) {
        return '<div class="db-table-row" data-table="' + escAttr(tbl.name) + '" style="padding:6px 8px;cursor:pointer;border-bottom:1px solid var(--border-light);">' +
          // R142: `.icon-text` so the table glyph centres on the table name
          // instead of riding the text baseline 1.3px low.
          '<div class="icon-text" style="font-weight:600;">' + icon("table", 12) + esc(tbl.name) + '</div>' +
          '<div class="hint-line">' + esc(t("db.row-count-n", "{n} rows").replace("{n}", String(tbl.rowCount))) + '</div>' +
        '</div>';
      }).join("");
      el.onclick = function(event) {
        var row = event.target.closest("[data-table]");
        if (!row || !el.contains(row)) return;
        agentBrowser.dbViewTable(row.dataset.table);
      };
    }).catch(function(e) {
      // R190: the catch only toasted — the list area kept its "加载中…"
      // placeholder forever, so the tab looked like it was still working
      // while the one signal sat in a toast that fades. Render the error
      // where the loading text was, with a retry, like the other tabs.
      var el = document.getElementById("db-tables");
      if (el && window.agentBrowser.renderViewState) {
        window.agentBrowser.renderViewState(el, { error: e.message || String(e), retry: { cmd: "loadDbTab" } });
      }
      toast(t("db.toast.load-failed","加载失败: ") + (e.message || e), "error");
    });
  };

  agentBrowser.dbViewTable = function(table) {
    api.agentDb.tableData(table, 100, 0).then(function(data) {
      var el = document.getElementById("db-result");
      if (!data || !data.rows || data.rows.length === 0) {
        el.innerHTML = '<div style="color:var(--text-muted);padding:12px;">' + esc(t("db.table-empty", "Table {table} is empty ({n} rows).").replace("{table}", table).replace("{n}", String(data ? data.total : 0))) + '</div>';
        return;
      }
      var cols = data.columns && data.columns.length ? data.columns : Object.keys(data.rows[0]);
      // R146: these were five fragments concatenated around the numbers, with
      // the separators baked into the *fallback* strings (" · ", " 行"). The
      // dictionary values have no such spacing, so EN rendered "128rows" and the
      // zh dictionary had to compensate with its own leading space. One template
      // per sentence instead: the translator controls the whole line.
      var html = '<div class="icon-text" style="margin-bottom:6px;font-size:11px;color:var(--text-muted);">' + icon("table", 12) +
        esc(t("db.table-head", "{table} · {shown}/{total} rows").replace("{table}", table).replace("{shown}", String(data.rows.length)).replace("{total}", String(data.total))) + '</div>';
      html += '<table class="db-grid"><thead><tr>';
      cols.forEach(function(c) { html += "<th>" + esc(c) + "</th>"; });
      html += "</tr></thead><tbody>";
      data.rows.forEach(function(r) {
        html += "<tr>";
        cols.forEach(function(c) {
          var v = r[c];
          var s = v === null || v === undefined ? t("db.null","(null)") : String(v);
          if (s.length > 80) s = s.slice(0, 80) + "…";
          html += "<td>" + esc(s) + "</td>";
        });
        html += "</tr>";
      });
      html += "</tbody></table>";
      el.innerHTML = html;
    }).catch(function(e) { toast(t("db.toast.read-failed","读取失败: ") + (e.message || e), "error"); });
  };

  agentBrowser.dbRunSql = function(mode) {
    var sql = document.getElementById("db-sql").value.trim();
    if (!sql) { toast(t("db.toast.no-sql","请输入 SQL"), "error"); return; }
    var el = document.getElementById("db-result");
    var isExec = mode === "exec";
    el.innerHTML = '<span style="color: var(--primary-text);">' + t("db.running","运行中...") + '</span>';
    if (isExec) {
      api.agentDb.exec(sql).then(function(r) {
        if (r.ok) {
          el.innerHTML = '<div style="color: var(--success-text);">' + t("db.exec-done","Executed.") + '</div>';
          agentBrowser.loadDbTab();
        } else {
          el.innerHTML = '<div style="color: var(--danger-text);">' + esc(r.error || t("db.exec-failed-default","Failed")) + "</div>";
        }
      }).catch(function(e) { el.innerHTML = '<div style="color: var(--danger-text);">' + esc(e.message || e) + "</div>"; });
    } else {
      api.agentDb.query(sql).then(function(r) {
        if (!r.ok) { el.innerHTML = '<div style="color: var(--danger-text);">' + esc(r.error || t("db.exec-failed-default","Failed")) + "</div>"; return; }
        var rows = r.rows || [];
        if (rows.length === 0) { el.innerHTML = '<div style="color:var(--text-muted);">' + esc(t("db.no-result", "No result ({n} rows)").replace("{n}", String(r.count))) + "</div>"; return; }
        var cols = Object.keys(rows[0]);
        var html = '<div style="margin-bottom:6px;font-size:11px;color:var(--text-muted);">' + esc(t("db.row-count-n", "{n} rows").replace("{n}", String(rows.length))) + (r.truncated ? " " + esc(t("db.truncated", "(truncated)")) : "") + '</div>';
        html += '<table class="db-grid"><thead><tr>';
        cols.forEach(function(c) { html += "<th>" + esc(c) + "</th>"; });
        html += "</tr></thead><tbody>";
        rows.forEach(function(row) {
          html += "<tr>";
          cols.forEach(function(c) {
            var v = row[c]; var s = v === null || v === undefined ? t("db.null","(null)") : String(v);
            if (s.length > 80) s = s.slice(0, 80) + "…";
            html += "<td>" + esc(s) + "</td>";
          });
          html += "</tr>";
        });
        html += "</tbody></table>";
        el.innerHTML = html;
      }).catch(function(e) { el.innerHTML = '<div style="color: var(--danger-text);">' + esc(e.message || e) + "</div>"; });
    }
  };
})();
