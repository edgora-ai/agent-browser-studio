// DB tab — browse the agent's SQLite tables + run SQL.
(function() {
  "use strict";
  var agentBrowser = window.agentBrowser;
  var api = agentBrowser.api;
  var helpers = agentBrowser.helpers;
  var toast = helpers.toast;
  var esc = helpers.esc;
  var escAttr = helpers.escAttr;

  function t(key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; }

  agentBrowser.loadDbTab = function() {
    api.agentDb.tables().then(function(tables) {
      var el = document.getElementById("db-tables");
      if (!tables || tables.length === 0) {
        el.innerHTML = '<div style="color:var(--text-muted);padding:8px;">' + t("db.empty-tables","还没有表。让 Agent 建一个,或在 SQL 框跑 <code>CREATE TABLE ...</code>。") + '</div>';
        return;
      }
      el.innerHTML = tables.map(function(tbl) {
        return '<div class="db-table-row" data-table="' + escAttr(tbl.name) + '" style="padding:6px 8px;cursor:pointer;border-bottom:1px solid var(--border-light);">' +
          '<div style="font-weight:600;">📋 ' + esc(tbl.name) + '</div>' +
          '<div style="font-size:10px;color:var(--text-muted);">' + tbl.rowCount + t("db.row-count"," 行") + '</div>' +
        '</div>';
      }).join("");
      el.onclick = function(event) {
        var row = event.target.closest("[data-table]");
        if (!row || !el.contains(row)) return;
        agentBrowser.dbViewTable(row.dataset.table);
      };
    }).catch(function(e) { toast(t("db.toast.load-failed","加载失败: ") + (e.message || e), "error"); });
  };

  agentBrowser.dbViewTable = function(table) {
    api.agentDb.tableData(table, 100, 0).then(function(data) {
      var el = document.getElementById("db-result");
      if (!data || !data.rows || data.rows.length === 0) {
        el.innerHTML = '<div style="color:var(--text-muted);padding:12px;">' + t("db.table-empty","表 <code>") + esc(table) + t("db.table-empty-mid","</code> 为空(共 ") + (data ? data.total : 0) + t("db.table-empty-end"," 行)。") + '</div>';
        return;
      }
      var cols = data.columns && data.columns.length ? data.columns : Object.keys(data.rows[0]);
      var html = '<div style="margin-bottom:6px;font-size:11px;color:var(--text-muted);">📋 ' + esc(table) + t("db.table-head"," · ") + data.rows.length + t("db.row-count-slash","/") + data.total + t("db.row-count"," 行") + '</div>';
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
    el.innerHTML = '<span style="color:var(--primary);">' + t("db.running","运行中...") + '</span>';
    if (isExec) {
      api.agentDb.exec(sql).then(function(r) {
        if (r.ok) {
          el.innerHTML = '<div style="color:var(--success);">' + t("db.exec-done","✅ 执行完成。") + '</div>';
          agentBrowser.loadDbTab();
        } else {
          el.innerHTML = '<div style="color:var(--danger);">' + t("db.exec-failed","❌ ") + esc(r.error || t("db.exec-failed-default","失败")) + "</div>";
        }
      }).catch(function(e) { el.innerHTML = '<div style="color:var(--danger);">' + esc(e.message || e) + "</div>"; });
    } else {
      api.agentDb.query(sql).then(function(r) {
        if (!r.ok) { el.innerHTML = '<div style="color:var(--danger);">' + t("db.exec-failed","❌ ") + esc(r.error || t("db.exec-failed-default","失败")) + "</div>"; return; }
        var rows = r.rows || [];
        if (rows.length === 0) { el.innerHTML = '<div style="color:var(--text-muted);">' + t("db.no-result","(无结果,") + r.count + t("db.no-result-end"," 行)") + "</div>"; return; }
        var cols = Object.keys(rows[0]);
        var html = '<div style="margin-bottom:6px;font-size:11px;color:var(--text-muted);">' + rows.length + (r.truncated ? t("db.truncated","+ (截断)") : "") + t("db.row-count"," 行") + '</div>';
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
      }).catch(function(e) { el.innerHTML = '<div style="color:var(--danger);">' + esc(e.message || e) + "</div>"; });
    }
  };
})();
