// 自动化任务 tab 逻辑(正经 dialog 编辑)
(function() {
  "use strict";
  var agentBrowser = window.agentBrowser;
  var api = agentBrowser.api;
  var helpers = agentBrowser.helpers;
  var toast = helpers.toast;
  var esc = helpers.esc;
  var escAttr = helpers.escAttr;

  function t(key, fallback) { return window.i18n ? window.i18n.t(key, fallback) : fallback; }

  var currentRules = [];
  var taskTemplates = [];

  function describeTrigger(tr) {
    if (!t) return '?';
    if (tr.type === 'cron') {
      var hint = cronHint(tr.cron);
      return t('auto.trigger.cron', '定时 ') + '<code style="font-family:var(--mono)">' + esc(tr.cron || '') + '</code>' + (hint ? ' <span style="color:var(--text-muted)">(' + esc(hint) + ')</span>' : '');
    }
    if (tr.type === 'once') return t('auto.trigger.once', '单次 ') + (tr.at ? new Date(tr.at).toLocaleString() : '?');
    if (tr.type === 'event') return t('auto.trigger.event', '事件 ') + esc(tr.event || '').replace('profile:','') + (tr.profileFilter ? ' (' + esc(tr.profileFilter).slice(0,8) + ')' : t('auto.trigger.event.all', ' (所有)'));
    return '?';
  }
  function describeAction(a) {
    if (!a) return '?';
    var map = { 'launch-profile': t('auto.action.launch','🚀 启动'), 'stop-profile': t('auto.action.stop','⏹ 停止'), 'agent-task': t('auto.action.agent','🤖 Agent'), 'sync-push': t('auto.action.push','☁️ Push'), 'sync-pull': t('auto.action.pull','☁️ Pull'), 'custom-js': t('auto.action.js','⚙️ JS') };
    var base = map[a.type] || a.type;
    if (a.profileDirId) base += ' ' + esc(a.profileDirId).slice(0,10);
    if (a.profileDirIds && a.profileDirIds.length > 1) base += ' ×' + a.profileDirIds.length + t('auto.action.batch-profiles', ' profiles');
    if (a.type === 'agent-task' && a.agentPrompt) base += ' <em style="color:var(--text-muted)">"' + esc(a.agentPrompt).slice(0,30) + '..."</em>';
    return base;
  }
  function cronHint(c) {
    if (!c) return '';
    var p = c.trim().split(/\s+/);
    if (p.length !== 5) return '';
    if (p[0]==='0' && p[1] && p[2]==='*' && p[3]==='*' && p[4]==='*') return t('auto.cron.daily','每天 ')+p[1]+':00';
    if (/^\*\//.test(p[0]) && p[1]==='*' && p[2]==='*' && p[3]==='*' && p[4]==='*') return t('auto.cron.every-min','每 ')+p[0].slice(2)+t('auto.cron.every-min-unit',' 分钟');
    if (p[1]==='*' && p[2]==='*' && p[3]==='*' && p[4]==='*') return t('auto.cron.every-hour','每小时 ')+p[0]+t('auto.cron.every-hour-unit',' 分');
    return '';
  }

  var JOB_STATUS_CLS = { queued: 'status-stopped', running: 'status-running', done: 'status-done', failed: 'status-stopped', skipped: 'status-stopped', cancelled: 'status-stopped' };

  function jobStatusBadge(job) {
    var cls = JOB_STATUS_CLS[job.status] || 'status-stopped';
    var label = t('auto.status.' + (job.status || ''), job.status || '?');
    return '<span class="status-badge ' + cls + '">' + esc(label) + '</span>';
  }

  function fmtJobTime(value) {
    return value ? new Date(value).toLocaleString() : '-';
  }

  function jobDuration(job) {
    if (!job || !job.startedAt) return '-';
    var end = job.finishedAt || Date.now();
    var ms = Math.max(0, end - job.startedAt);
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return Math.round(ms / 60000) + 'm';
  }

  function jobSummary(job) {
    var text = job.error || job.result || '';
    return text ? String(text).slice(0, 140) : t('auto.no-result', '(无结果)');
  }

  function canCancelJob(job) {
    return job && (job.status === 'queued' || job.status === 'running');
  }

  function jobDetailText(job) {
    return JSON.stringify({
      id: job.id,
      ruleId: job.ruleId,
      ruleName: job.ruleName,
      source: job.source,
      status: job.status,
      attempt: job.attempt,
      runId: job.runId,
      createdAt: fmtJobTime(job.createdAt),
      startedAt: fmtJobTime(job.startedAt),
      finishedAt: fmtJobTime(job.finishedAt),
      result: job.result,
      error: job.error,
    }, null, 2);
  }

  function fillProfileSelect(selId, selected) {
    api.browser.list().then(function(list) {
      var sel = document.getElementById(selId);
      var cur = sel.value;
      sel.innerHTML = '<option value="">' + esc(t('auto.select-profile', '(选择 profile)')) + '</option>' + (list || []).map(function(p) {
        return '<option value="' + escAttr(p.dirId) + '"' + (p.dirId === selected ? ' selected' : '') + '>' + esc(p.name) + '</option>';
      }).join('');
      if (selected && !sel.value) sel.value = selected;
    });
  }

  function fillProfileMultiSelect(selId, selectedArr) {
    api.browser.list().then(function(list) {
      var sel = document.getElementById(selId);
      var selected = selectedArr || [];
      sel.innerHTML = (list || []).map(function(p) {
        return '<option value="' + escAttr(p.dirId) + '"' + (selected.indexOf(p.dirId) >= 0 ? ' selected' : '') + '>' + esc(p.name) + '</option>';
      }).join('');
    });
  }

  function updateTriggerVisibility() {
    var type = document.getElementById('auto-trigger-type').value;
    document.getElementById('auto-cron-row').style.display = type === 'cron' ? '' : 'none';
    document.getElementById('auto-once-row').style.display = type === 'once' ? '' : 'none';
    document.getElementById('auto-event-row').style.display = type === 'event' ? '' : 'none';
    document.getElementById('auto-event-filter-row').style.display = type === 'event' ? '' : 'none';
  }
  function updateActionVisibility() {
    var type = document.getElementById('auto-action-type').value;
    var batch = document.getElementById('auto-action-batch') && document.getElementById('auto-action-batch').checked;
    var isAgent = type === 'agent-task';
    var needsSingle = type === 'launch-profile' || type === 'stop-profile' || (isAgent && !batch);
    document.getElementById('auto-action-profile-row').style.display = needsSingle ? '' : 'none';
    document.getElementById('auto-action-batch-row').style.display = isAgent ? '' : 'none';
    document.getElementById('auto-action-profiles-row').style.display = (isAgent && batch) ? '' : 'none';
    document.getElementById('auto-action-concurrency-row').style.display = (isAgent && batch) ? '' : 'none';
    document.getElementById('auto-action-template-row').style.display = isAgent ? '' : 'none';
    document.getElementById('auto-action-prompt-row').style.display = isAgent ? '' : 'none';
    document.getElementById('auto-action-js-row').style.display = type === 'custom-js' ? '' : 'none';
  }

  function fillTemplateSelect() {
    var sel = document.getElementById('auto-action-template');
    if (!sel) return;
    var selected = sel.value;
    sel.innerHTML = '<option value="">' + esc(t('auto.no-template', '(不使用模板)')) + '</option>' + taskTemplates.map(function(tpl) {
      return '<option value="' + escAttr(tpl.id) + '">' + esc(tpl.title) + ' · ' + esc(tpl.category) + ' · ' + esc(tpl.riskLevel) + '</option>';
    }).join('');
    if (selected) sel.value = selected;
  }

  function templatePrompt(tpl) {
    if (!tpl) return '';
    var lines = [
      t('auto.template-using', '使用模板 ') + tpl.id + t('auto.template-sep', ' — ') + tpl.title,
      '',
      tpl.prompt || tpl.examplePrompt || tpl.description || '',
    ];
    if (tpl.requiredInputs && tpl.requiredInputs.length) {
      lines.push('', t('auto.template-required-inputs', '必填输入:'));
      (tpl.requiredInputs || []).forEach(function(input) {
        lines.push('- ' + input.key + (input.required ? ' ' + t('auto.template-required', '(required)') : ' ' + t('auto.template-optional', '(optional)')) + ': ' + (input.description || '') + (input.example ? t('auto.template-example', ' 示例: ') + input.example : ''));
      });
    }
    if (tpl.steps && tpl.steps.length) {
      lines.push('', t('auto.template-steps', '执行步骤:'));
      (tpl.steps || []).forEach(function(step, index) { lines.push((index + 1) + '. ' + step); });
    }
    if (tpl.successCriteria && tpl.successCriteria.length) {
      lines.push('', t('auto.template-criteria', '成功标准:'));
      (tpl.successCriteria || []).forEach(function(item) { lines.push('- ' + item); });
    }
    return lines.join('\n');
  }

  function applyTemplateSelection() {
    var id = document.getElementById('auto-action-template').value;
    var tpl = taskTemplates.find(function(t) { return t.id === id; });
    var hint = document.getElementById('auto-template-hint');
    if (!tpl) { hint.textContent = ''; return; }
    hint.textContent = t('auto.hint-risk', 'risk=') + tpl.riskLevel + t('auto.hint-tools', ' · tools=') + (tpl.tools || []).join(', ') + t('auto.hint-success', ' · success=') + (tpl.successCriteria || []).slice(0, 2).join('; ');
    document.getElementById('auto-action-prompt').value = templatePrompt(tpl);
  }

  // R15 UX P1-7: list failure gets an error state + retry, not a stuck Loading.
  agentBrowser.loadAutomationTab = function() {
    api.automation.list().then(function(rules) {
      currentRules = rules || [];
      var el = document.getElementById('automation-list');
      if (!rules || rules.length === 0) {
        if (window.agentBrowser && window.agentBrowser.renderViewState) { window.agentBrowser.renderViewState(el, { empty: t('auto.empty-state','暂无任务'), cta:{label:'新建任务',cmd:'automationNew'}}); } else el.innerHTML = '<div class="empty-state">' + t('auto.empty-state', '还没有自动化任务。<br>点「+ 新建任务」创建,或让 Agent 帮你建(在 Agent 里说"每天9点启动demo")。') + '</div>';
      } else {
        el.innerHTML = rules.map(function(r) {
          return '<div class="profile-card" data-rule-id="' + escAttr(r.id) + '">' +
            '<div class="card-header"><span class="name">' + esc(r.name) + '</span>' +
              '<span class="status-badge ' + (r.enabled ? 'status-running' : 'status-stopped') + '">' + esc(r.enabled ? t('auto.enabled','启用') : t('auto.disabled','停用')) + '</span></div>' +
            '<div class="info-row"><span>' + esc(t('auto.row.trigger','触发')) + '</span><span style="font-size:12px;">' + describeTrigger(r.trigger) + '</span></div>' +
            '<div class="info-row"><span>' + esc(t('auto.row.action','动作')) + '</span><span style="font-size:12px;">' + describeAction(r.action) + '</span></div>' +
            (r.lastRunAt ? '<div class="info-row"><span>' + esc(t('auto.row.last','上次')) + '</span><span style="font-size:11px;color:' + (r.lastResult && !r.lastResult.includes('error') && !r.lastResult.includes('failed') ? 'var(--success)' : 'var(--text-muted)') + ';">' + new Date(r.lastRunAt).toLocaleString() + '</span></div>' : '') +
            '<div class="card-actions">' +
              '<button class="btn btn-secondary btn-sm" data-rule-action="toggle">' + esc(r.enabled ? t('auto.disabled','停用') : t('auto.enabled','启用')) + '</button>' +
              '<button class="btn btn-secondary btn-sm" data-rule-action="test">' + esc(t('auto.btn.test','测试运行')) + '</button>' +
              '<button class="btn btn-secondary btn-sm" data-rule-action="edit">' + esc(t('auto.btn.edit','编辑')) + '</button>' +
              '<button class="btn btn-danger btn-sm" data-rule-action="delete">' + esc(t('auto.btn.delete','删除')) + '</button>' +
            '</div>' +
          '</div>';
        }).join('');
        el.onclick = function(event) {
          var target = event.target.closest('[data-rule-action]');
          if (!target || !el.contains(target)) return;
          var card = target.closest('[data-rule-id]');
          var ruleId = card && card.dataset.ruleId;
          var action = target.dataset.ruleAction;
          var rule = currentRules.find(function(x){return x.id===ruleId;});
          if (action === 'toggle') agentBrowser.automationToggle(rule);
          else if (action === 'test') agentBrowser.automationTest(ruleId);
          else if (action === 'edit') agentBrowser.automationEdit(rule);
          else if (action === 'delete') agentBrowser.automationDelete(ruleId);
        };
      }
    }).catch(function(e) {
      var errEl = document.getElementById('automation-list');
      var msg = (e && e.message) || String(e);
      if (window.agentBrowser && window.agentBrowser.renderViewState) {
        window.agentBrowser.renderViewState(errEl, { error: msg, retry: { cmd: 'loadAutomationTab' } });
      } else if (errEl) {
        errEl.innerHTML = '<div class="empty-state">Error: ' + esc(msg) + '</div>';
      }
      toast(msg, 'error');
    });
    agentBrowser.automationRefreshLogs();
    agentBrowser.automationRefreshJobs();
  };

  agentBrowser.automationRefreshJobs = function() {
    var el = document.getElementById('automation-jobs');
    if (!el) return;
    var statusEl = document.getElementById('automation-job-status');
    var status = statusEl && statusEl.value;
    el.innerHTML = '<div class="loading">' + esc(t('auto.loading', 'Loading...')) + '</div>';
    api.automation.jobs({ status: status || undefined, limit: 50 }).then(function(jobs) {
      if (!jobs || jobs.length === 0) {
        if (window.agentBrowser && window.agentBrowser.renderViewState) window.agentBrowser.renderViewState(el,{empty:t('auto.jobs.empty','暂无 jobs')}); else el.innerHTML = '<div class="empty-state">' + t('auto.jobs.empty', '还没有 durable jobs。<br>点击「测试运行」后会在这里看到执行记录。') + '</div>';
        return;
      }
      el.innerHTML = jobs.map(function(job) {
        var summary = jobSummary(job);
        var runLink = job.runId
          ? '<button class="btn btn-secondary btn-sm" data-job-action="open-run">' + esc(t('auto.jobs.btn.open-run','打开 Run')) + '</button>'
          : '';
        var cancel = canCancelJob(job)
          ? '<button class="btn btn-danger btn-sm" data-job-action="cancel">' + esc(t('auto.jobs.btn.cancel','取消')) + '</button>'
          : '';
        return '<div class="profile-card" data-job-id="' + escAttr(job.id) + '">' +
          '<div class="card-header"><span class="name">' + esc(job.ruleName || job.ruleId || job.id) + '</span>' + jobStatusBadge(job) + '</div>' +
          '<div class="info-row"><span>' + esc(t('auto.jobs.row.job','Job')) + '</span><span style="font-family:var(--mono);font-size:11px;">' + esc(job.id) + '</span></div>' +
          '<div class="info-row"><span>' + esc(t('auto.jobs.row.source','来源')) + '</span><span>' + esc(job.source || '-') + ' · attempt ' + esc(job.attempt) + '</span></div>' +
          '<div class="info-row"><span>' + esc(t('auto.jobs.row.created','创建')) + '</span><span>' + esc(fmtJobTime(job.createdAt)) + '</span></div>' +
          '<div class="info-row"><span>' + esc(t('auto.jobs.row.duration','耗时')) + '</span><span>' + esc(jobDuration(job)) + '</span></div>' +
          (job.runId ? '<div class="info-row"><span>' + esc(t('auto.jobs.row.run','Run')) + '</span><span style="font-family:var(--mono);font-size:11px;">' + esc(job.runId) + '</span></div>' : '') +
          '<div style="font-size:11px;color:' + (job.error ? 'var(--danger)' : 'var(--text-muted)') + ';margin:6px 0;line-height:1.35;">' + esc(summary) + '</div>' +
          '<div class="card-actions">' +
            '<button class="btn btn-secondary btn-sm" data-job-action="detail">' + esc(t('auto.jobs.row.summary','详情')) + '</button>' +
            runLink + cancel +
          '</div>' +
        '</div>';
      }).join('');
      el.onclick = function(event) {
        var btn = event.target.closest('[data-job-action]');
        if (!btn || !el.contains(btn)) return;
        var card = btn.closest('[data-job-id]');
        var jobId = card && card.dataset.jobId;
        var job = (jobs || []).find(function(x) { return x.id === jobId; });
        if (btn.dataset.jobAction === 'detail') agentBrowser.automationShowJob(jobId);
        else if (btn.dataset.jobAction === 'open-run' && job && job.runId) agentBrowser.runsOpen(job.runId);
        else if (btn.dataset.jobAction === 'cancel') agentBrowser.automationCancelJob(jobId);
      };
    }).catch(function(e) {
      if (window.agentBrowser && window.agentBrowser.renderViewState) window.agentBrowser.renderViewState(el,{error: e.message||String(e), retry:{cmd:'automationRefreshJobs'}}); else el.innerHTML = '<div class="empty-state">' + esc(t('auto.jobs.load-failed','加载 jobs 失败: ')) + esc(e.message || e) + '</div>';
      toast(t('auto.jobs.load-failed','加载 jobs 失败: ') + (e.message || e), 'error');
    });
  };

  agentBrowser.automationShowJob = function(jobId) {
    if (!jobId) return;
    api.automation.jobGet(jobId).then(function(job) {
      if (!job) { toast(t('auto.jobs.not-found','Job 不存在'), 'error'); return; }
      document.getElementById('auto-job-title').textContent = job.id;
      document.getElementById('auto-job-detail').textContent = jobDetailText(job);
      var actions = document.getElementById('auto-job-actions');
      actions.innerHTML = (job.runId ? '<button class="btn btn-secondary btn-sm" data-role="cmd" data-cmd="runsOpen" data-cmd-arg="' + escAttr(job.runId) + '">' + esc(t('auto.jobs.open-run','打开关联 Run')) + '</button>' : '') +
        (canCancelJob(job) ? '<button class="btn btn-danger btn-sm" data-role="cmd" data-cmd="automationCancelJob" data-cmd-arg="' + escAttr(job.id) + '">' + esc(t('auto.jobs.cancel-job','取消 Job')) + '</button>' : '');
      document.getElementById('dlg-auto-job').showModal();
    }).catch(function(e) { toast(t('auto.jobs.load-job-failed','加载 job 失败: ') + (e.message || e), 'error'); });
  };

  agentBrowser.automationCancelJob = function(jobId) {
    if (!jobId) return;
    agentBrowser.confirm(t('auto.jobs.confirm-cancel','取消此 job? 已经开始的外部副作用不会回滚。'), function() {
      api.automation.jobCancel(jobId).then(function(r) {
        toast(r && r.success ? t('auto.jobs.cancelled','已取消 job') : t('auto.jobs.cancel-failed','取消失败'), r && r.success ? 'success' : 'error');
        var dlg = document.getElementById('dlg-auto-job');
        if (dlg && dlg.open) dlg.close();
        agentBrowser.automationRefreshJobs();
      }).catch(function(e) { toast(t('auto.jobs.cancel-error','取消 job 失败: ') + (e.message || e), 'error'); });
    });
  };

  agentBrowser.automationRefreshLogs = function() {
    api.automation.logs().then(function(logs) {
      var logEl = document.getElementById('automation-log');
      if (!logs || logs.length === 0) { logEl.textContent = t('auto.log.empty', '(空)'); return; }
      logEl.innerHTML = logs.slice(0, 50).map(function(l, i) {
        return '<div data-log-idx="' + i + '" style="padding:2px 0;cursor:pointer;border-bottom:1px solid var(--border-light);">' +
          '<span style="color:var(--text-muted);">' + new Date(l.at).toLocaleString() + '</span> ' +
          (l.ok ? '✅' : '❌') + ' <strong>' + esc(l.ruleName) + '</strong>: ' + esc(l.result).slice(0, 80) +
        '</div>';
      }).join('');
      logEl.onclick = function(event) {
        var row = event.target.closest('[data-log-idx]');
        if (!row) return;
        agentBrowser.automationShowLogDetail(logs[Number(row.dataset.logIdx)]);
      };
    });
  };

  agentBrowser.automationShowLogDetail = function(log) {
    if (!log) return;
    var detail = t('auto.log.task','任务: ') + log.ruleName + ' (' + log.ruleId + ')\n' +
      t('auto.log.time','时间: ') + new Date(log.at).toLocaleString() + '\n' +
      t('auto.log.result','结果: ') + (log.ok ? t('auto.log.success','✅ 成功') : t('auto.log.failure','❌ 失败')) + '\n' +
      t('auto.log.detail','详情:\n') + log.result;
    document.getElementById('auto-log-detail').textContent = detail;
    document.getElementById('dlg-auto-log').showModal();
  };

  function openEditor(rule) {
    document.getElementById('auto-dlg-title').textContent = rule ? t('auto.editor.edit-title','编辑任务') : t('auto.editor.new-title','新建任务');
    document.getElementById('auto-id').value = rule ? rule.id : '';
    document.getElementById('auto-name').value = rule ? rule.name : '';
    var tt = rule ? rule.trigger.type : 'cron';
    document.getElementById('auto-trigger-type').value = tt;
    if (rule && rule.trigger.cron) document.getElementById('auto-cron').value = rule.trigger.cron;
    else document.getElementById('auto-cron').value = '0 9 * * *';
    if (rule && rule.trigger.at) {
      var d = new Date(rule.trigger.at);
      var pad = function(n){return n<10?'0'+n:n;};
      document.getElementById('auto-once').value = d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
    } else { document.getElementById('auto-once').value = ''; }
    if (rule && rule.trigger.event) document.getElementById('auto-event').value = rule.trigger.event;
    fillProfileSelect('auto-event-profile', rule && rule.trigger.profileFilter);
    var at = rule ? rule.action.type : 'launch-profile';
    document.getElementById('auto-action-type').value = at;
    var batchMode = !!(rule && rule.action.profileDirIds && rule.action.profileDirIds.length > 0);
    document.getElementById('auto-action-batch').checked = batchMode;
    fillProfileSelect('auto-action-profile', rule && rule.action.profileDirId);
    fillProfileMultiSelect('auto-action-profiles', rule && rule.action.profileDirIds);
    document.getElementById('auto-action-concurrency').value = (rule && rule.action.concurrency) || 1;
    fillTemplateSelect();
    document.getElementById('auto-action-template').value = (rule && rule.action.templateId) || '';
    document.getElementById('auto-template-hint').textContent = '';
    document.getElementById('auto-action-prompt').value = '';
    if (rule && rule.action.templateId) applyTemplateSelection();
    if (rule && rule.action.agentPrompt) document.getElementById('auto-action-prompt').value = rule.action.agentPrompt;
    document.getElementById('auto-action-js').value = (rule && rule.action.jsCode) || '';
    document.getElementById('auto-enabled').checked = rule ? rule.enabled : true;
    updateTriggerVisibility();
    updateActionVisibility();
    document.getElementById('auto-trigger-type').onchange = updateTriggerVisibility;
    document.getElementById('auto-action-type').onchange = updateActionVisibility;
    document.getElementById('auto-action-batch').onchange = updateActionVisibility;
    document.getElementById('auto-action-template').onchange = applyTemplateSelection;
    document.getElementById('auto-cron').oninput = function() {
      var c = this.value;
      var hintEl = document.getElementById('auto-cron-hint');
      if (!c) { hintEl.textContent = ''; return; }
      api.automation.validateCron(c).then(function(v) {
        hintEl.textContent = v.valid ? (cronHint(c) || t('auto.cron.valid','✓ 有效')) : (t('auto.cron.invalid','✗ ') + v.error);
        hintEl.style.color = v.valid ? 'var(--success)' : 'var(--danger)';
      });
    };
    document.getElementById('dlg-automation').showModal();
  }

  agentBrowser.automationNew = function() {
    var open = function() { openEditor(null); };
    if (taskTemplates.length || !api.agent.taskTemplates) { open(); return; }
    api.agent.taskTemplates().then(function(list) { taskTemplates = list || []; open(); }).catch(open);
  };
  agentBrowser.automationEdit = function(rule) {
    var open = function() { openEditor(rule); };
    if (taskTemplates.length || !api.agent.taskTemplates) { open(); return; }
    api.agent.taskTemplates().then(function(list) { taskTemplates = list || []; open(); }).catch(open);
  };

  agentBrowser.saveAutomation = function() {
    var id = document.getElementById('auto-id').value;
    var name = document.getElementById('auto-name').value.trim() || 'Untitled';
    var triggerType = document.getElementById('auto-trigger-type').value;
    var trigger = { type: triggerType };
    if (triggerType === 'cron') trigger.cron = document.getElementById('auto-cron').value.trim();
    else if (triggerType === 'once') {
      var at = new Date(document.getElementById('auto-once').value).getTime();
      if (isNaN(at)) { toast(t('auto.error.invalid-time','执行时间无效'), 'error'); return; }
      trigger.at = at;
    } else if (triggerType === 'event') {
      trigger.event = document.getElementById('auto-event').value;
      var pf = document.getElementById('auto-event-profile').value;
      if (pf) trigger.profileFilter = pf;
    }
    var actionType = document.getElementById('auto-action-type').value;
    var action = { type: actionType };
    if (['launch-profile','stop-profile'].includes(actionType)) {
      action.profileDirId = document.getElementById('auto-action-profile').value;
      if (!action.profileDirId) { toast(t('auto.error.select-profile','请选择 profile'), 'error'); return; }
    } else if (actionType === 'agent-task') {
      if (document.getElementById('auto-action-batch').checked) {
        var opts = document.getElementById('auto-action-profiles').selectedOptions || [];
        action.profileDirIds = [];
        for (var i = 0; i < opts.length; i++) { if (opts[i].value) action.profileDirIds.push(opts[i].value); }
        if (!action.profileDirIds.length) { toast(t('auto.error.select-profiles','请选择至少一个 profile'), 'error'); return; }
        var con = parseInt(document.getElementById('auto-action-concurrency').value, 10);
        if (!con || isNaN(con)) con = 1;
        action.concurrency = Math.max(1, Math.min(con, 16));
      } else {
        action.profileDirId = document.getElementById('auto-action-profile').value;
        if (!action.profileDirId) { toast(t('auto.error.select-profile','请选择 profile'), 'error'); return; }
      }
    }
    if (actionType === 'agent-task') {
      action.templateId = document.getElementById('auto-action-template').value || undefined;
      action.agentPrompt = document.getElementById('auto-action-prompt').value.trim();
    }
    if (actionType === 'custom-js') action.jsCode = document.getElementById('auto-action-js').value;
    var enabled = document.getElementById('auto-enabled').checked;
    var payload = { name: name, enabled: enabled, trigger: trigger, action: action };
    // R15 UX P1-9/P1-12: keep the dialog open until the save succeeds (a
    // failure used to close first and lose the input), disable Save in
    // flight, and honor the backend success flag on toggle/delete.
    var saveBtn = document.querySelector('#dlg-automation button[type="submit"]');
    if (saveBtn) saveBtn.setAttribute("disabled", "disabled");
    var p = id ? api.automation.update(Object.assign({ id: id }, payload)) : api.automation.create(payload);
    p.then(function(r) {
      if (saveBtn) saveBtn.removeAttribute("disabled");
      if (r && r.success === false) {
        toast(t('auto.save-failed','失败: ') + (r.error || ''), 'error');
        return;
      }
      document.getElementById('dlg-automation').close();
      toast(id ? t('auto.saved','已更新') : t('auto.created','已创建'), 'success');
      agentBrowser.loadAutomationTab();
    }).catch(function(e) {
      if (saveBtn) saveBtn.removeAttribute("disabled");
      toast((e && e.message) || String(e), 'error');
    });
  };

  agentBrowser.automationToggle = function(rule) {
    if (!rule) return;
    api.automation.update({ id: rule.id, enabled: !rule.enabled, name: rule.name, trigger: rule.trigger, action: rule.action }).then(function(r) {
      if (r && r.success === false) { toast(r.error || t('toast.failed','操作失败'), 'error'); return; }
      agentBrowser.loadAutomationTab();
    }).catch(function(e) { toast((e && e.message) || String(e), 'error'); });
  };
  agentBrowser.automationTest = function(ruleId) {
    toast(t('auto.test-running','测试运行中...'), 'info');
    api.automation.testRun(ruleId).then(function(r) {
      var ok = !!(r && r.ok);
      var text = String((r && (r.result != null ? r.result : r.error)) || 'unknown error').slice(0, 60);
      toast((ok ? t('auto.test-ok','✅ ') : t('auto.test-fail','❌ ')) + text, ok ? 'success' : 'error');
      setTimeout(function(){ agentBrowser.loadAutomationTab(); }, 500);
    }).catch(function(e) { toast((e && e.message) || String(e), 'error'); });
  };
  agentBrowser.automationDelete = function(ruleId) {
    agentBrowser.confirm(t('auto.confirm-delete','删除此任务?'), function() {
      api.automation.delete(ruleId).then(function(r) {
        if (r && r.success === false) { toast(r.error || t('toast.failed','删除失败'), 'error'); return; }
        toast(t('auto.deleted','已删除'), 'success');
        agentBrowser.loadAutomationTab();
      }).catch(function(e) { toast((e && e.message) || String(e), 'error'); });
    });
  };
})();
