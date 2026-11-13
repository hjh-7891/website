/**
 * 违规记录管理系统 · 前端
 * 数据全部来自服务端 /api，页面本身不存任何业务数据。
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'vr_token';
  var REMEMBER_KEY = 'vr_remember_30d';
  var REMEMBER_DAYS = 30;
  var STEAM_SUFFIX = '@steam';
  var PAGE_SIZE = 10;

  var state = {
    token: sessionStorage.getItem(TOKEN_KEY) || readRememberToken(),
    user: null,
    records: [],
    users: [],
    page: 1,
    search: '',
    editingId: null,
    resetUserId: null
  };

  /* ---------------------------------------------------------------- */
  /* 基础工具                                                          */
  /* ---------------------------------------------------------------- */

  function $(id) {
    return document.getElementById(id);
  }

  function toast(message, isError) {
    var el = $('toast');
    el.textContent = message;
    el.style.background = isError ? '#8f3535' : '#1f242b';
    el.hidden = false;
    el.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.hidden = true; }, 220);
    }, 2200);
  }

  function setError(el, message) {
    if (!message) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.textContent = message;
    el.hidden = false;
  }

  function formatDateTime(value) {
    if (!value) return '';
    var text = String(value).replace('T', ' ');
    if (text.length > 16) text = text.slice(0, 16);
    return text;
  }

  function formatDate(value) {
    if (!value) return '';
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function nowForInput() {
    var d = new Date();
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ---------------------------------------------------------------- */
  /* 接口调用                                                          */
  /* ---------------------------------------------------------------- */

  function api(path, options) {
    options = options || {};
    var headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;

    return fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    }).then(function (res) {
      return res.json().catch(function () {
        return { ok: false, error: '服务器返回内容无法解析（HTTP ' + res.status + '）' };
      }).then(function (data) {
        if (res.status === 401) {
          forceLogout('登录已失效，请重新登录');
          throw new Error(data.error || '未登录');
        }
        if (!data.ok) throw new Error(data.error || '操作失败');
        return data.data;
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* 30 天免登录：token 存在 localStorage，到期时间一起存               */
  /* ---------------------------------------------------------------- */

  function readRememberToken() {
    try {
      var raw = localStorage.getItem(REMEMBER_KEY);
      if (!raw) return '';
      var saved = JSON.parse(raw);
      if (!saved || !saved.token) return '';
      if (typeof saved.exp === 'number' && Date.now() > saved.exp) {
        localStorage.removeItem(REMEMBER_KEY);
        return '';
      }
      return saved.token;
    } catch (e) {
      return '';
    }
  }

  function saveRememberToken(token) {
    try {
      localStorage.setItem(REMEMBER_KEY, JSON.stringify({
        token: token,
        exp: Date.now() + REMEMBER_DAYS * 24 * 3600 * 1000
      }));
    } catch (e) {
      /* 隐私模式写入失败时忽略，本次登录仍可用 */
    }
  }

  function clearRememberToken() {
    try {
      localStorage.removeItem(REMEMBER_KEY);
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------------------------------------------------------- */
  /* 登录 / 退出                                                       */
  /* ---------------------------------------------------------------- */

  function forceLogout(message) {
    state.token = '';
    state.user = null;
    sessionStorage.removeItem(TOKEN_KEY);
    clearRememberToken();
    $('appView').hidden = true;
    $('loginView').hidden = false;
    $('recordForm').reset();
    hideWatermark();
    if (message) setError($('loginError'), message);
    window.scrollTo(0, 0);
  }

  function enterApp(user) {
    state.user = user;
    state.page = 1;
    state.search = '';
    $('recordSearch').value = '';
    $('loginView').hidden = true;
    $('appView').hidden = false;
    $('workspacePane').hidden = false;
    $('usersPane').hidden = true;
    $('appView').classList.toggle('is-admin', user.role === 'admin');
    $('currentUserLabel').textContent = user.username;
    $('currentUserRole').textContent = user.role === 'admin' ? '管理员' : '普通账号';
    $('rTime').value = nowForInput();
    setError($('loginError'), '');
    updateWatermark();
    refreshAll();
  }

  function login(username, password, remember) {
    var btn = $('loginSubmit');
    btn.disabled = true;
    btn.textContent = '登录中…';
    setError($('loginError'), '');

    return api('/api/login', { method: 'POST', body: { username: username, password: password, remember: Boolean(remember) } })
      .then(function (data) {
        state.token = data.token;
        sessionStorage.setItem(TOKEN_KEY, data.token);
        if (remember) {
          saveRememberToken(data.token);
        } else {
          clearRememberToken();
        }
        enterApp(data.user);
      })
      .catch(function (err) {
        setError($('loginError'), err.message);
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = '登录';
      });
  }

  function logout() {
    var token = state.token;
    state.token = '';
    sessionStorage.removeItem(TOKEN_KEY);
    clearRememberToken();
    if (token) {
      fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } })
        .catch(function () { /* 忽略 */ });
    }
    forceLogout('');
  }

  /* ---------------------------------------------------------------- */
  /* 数据加载与渲染                                                    */
  /* ---------------------------------------------------------------- */

  /* Steam64ID 统一带固定后缀 @steam：填写时只输数字，存库存完整形式 */
  function withSteamSuffix(value) {
    var v = String(value == null ? '' : value).trim();
    if (!v) return '';
    var tail = v.toLowerCase().slice(-STEAM_SUFFIX.length);
    return tail === STEAM_SUFFIX ? v : v + STEAM_SUFFIX;
  }

  function stripSteamSuffix(value) {
    var v = String(value == null ? '' : value).trim();
    if (v && v.toLowerCase().slice(-STEAM_SUFFIX.length) === STEAM_SUFFIX) {
      return v.slice(0, v.length - STEAM_SUFFIX.length);
    }
    return v;
  }

  function refreshAll() {
    var tasks = [loadRecords()];
    if (state.user && state.user.role === 'admin') tasks.push(loadUsers());
    return Promise.all(tasks).catch(function (err) {
      toast(err.message, true);
    });
  }

  function loadRecords() {
    return api('/api/records').then(function (items) {
      state.records = items;
      renderRecords();
    });
  }

  function loadUsers() {
    return api('/api/users').then(function (items) {
      state.users = items;
      renderUsers();
    });
  }

  function filteredRecords() {
    var keyword = state.search.trim().toLowerCase();
    if (!keyword) return state.records;
    return state.records.filter(function (r) {
      return [r.steamId, r.violationType, r.handler, r.handleResult, r.remark]
        .join(' ').toLowerCase().indexOf(keyword) !== -1;
    });
  }

  function cell(text, className, title) {
    var td = document.createElement('td');
    if (className) td.className = className;
    if (text === null || text === undefined || text === '') {
      td.textContent = '—';
      td.classList.add('muted-dash');
    } else {
      var span = document.createElement('span');
      span.textContent = String(text);
      if (className && className.indexOf('clamp-2') !== -1) span.className = 'clamp-2';
      td.appendChild(span);
      if (title) td.title = String(text);
    }
    return td;
  }

  function renderRecords() {
    var body = $('recordBody');
    var items = filteredRecords();
    var totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    if (state.page > totalPages) state.page = totalPages;

    var start = (state.page - 1) * PAGE_SIZE;
    var pageItems = items.slice(start, start + PAGE_SIZE);

    body.textContent = '';
    $('recordCount').textContent = String(state.records.length);
    $('recordEmpty').hidden = items.length !== 0;
    $('recordEmpty').textContent = state.records.length === 0
      ? '暂无记录，先在上方登记一条'
      : '没有匹配的记录，换个关键词试试';

    pageItems.forEach(function (r) {
      var tr = document.createElement('tr');

      var storedSteam = String(r.steamId || '');
      var steamBase = stripSteamSuffix(storedSteam);
      var steamCell = document.createElement('td');
      steamCell.className = 'cell-mono';
      steamCell.textContent = steamBase;
      if (storedSteam.length !== steamBase.length) {
        var steamTail = document.createElement('span');
        steamTail.className = 'cell-suffix';
        steamTail.textContent = STEAM_SUFFIX;
        steamCell.appendChild(steamTail);
      }
      tr.appendChild(steamCell);
      tr.appendChild(cell(r.violationType, 'cell-strong'));
      tr.appendChild(cell(r.handleResult, 'clamp-2', r.handleResult));
      tr.appendChild(cell(r.handler));
      tr.appendChild(cell(formatDateTime(r.handleTime)));
      tr.appendChild(cell(r.remark, 'clamp-2', r.remark));

      var actions = document.createElement('td');
      actions.className = 'col-actions admin-only';
      var wrap = document.createElement('div');
      wrap.className = 'row-actions';

      var editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-link';
      editBtn.textContent = '编辑';
      editBtn.addEventListener('click', function () { openEditRecord(r); });

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-link danger';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', function () { deleteRecord(r); });

      wrap.appendChild(editBtn);
      wrap.appendChild(delBtn);
      actions.appendChild(wrap);
      tr.appendChild(actions);

      body.appendChild(tr);
    });

    var pager = $('recordPager');
    pager.hidden = items.length <= PAGE_SIZE;
    $('pageInfo').textContent = '第 ' + state.page + ' / ' + totalPages + ' 页，共 ' + items.length + ' 条';
    $('pagePrev').disabled = state.page <= 1;
    $('pageNext').disabled = state.page >= totalPages;
  }

  function renderUsers() {
    var body = $('userBody');
    var isAdmin = state.user && state.user.role === 'admin';
    body.textContent = '';

    $('statTotal').textContent = String(state.users.length);
    $('statActive').textContent = String(state.users.filter(function (u) { return u.status === 'active'; }).length);
    $('statAdmin').textContent = String(state.users.filter(function (u) { return u.role === 'admin'; }).length);

    state.users.forEach(function (u) {
      var tr = document.createElement('tr');

      var nameCell = document.createElement('td');
      var nameSpan = document.createElement('span');
      nameSpan.className = 'cell-strong';
      nameSpan.textContent = u.username;
      nameCell.appendChild(nameSpan);
      if (state.user && u.id === state.user.id) {
        var me = document.createElement('span');
        me.className = 'muted-dash';
        me.textContent = '（我）';
        me.style.marginLeft = '4px';
        me.style.fontSize = '11.5px';
        nameCell.appendChild(me);
      }
      tr.appendChild(nameCell);

      var roleCell = document.createElement('td');
      var roleBadge = document.createElement('span');
      roleBadge.className = 'badge ' + (u.role === 'admin' ? 'badge-admin' : 'badge-normal');
      roleBadge.textContent = u.role === 'admin' ? '管理员' : '普通账号';
      roleCell.appendChild(roleBadge);
      tr.appendChild(roleCell);

      var statusCell = document.createElement('td');
      var statusBadge = document.createElement('span');
      statusBadge.className = 'badge ' + (u.status === 'active' ? 'badge-active' : 'badge-disabled');
      statusBadge.textContent = u.status === 'active' ? '正常' : '已停用';
      statusCell.appendChild(statusBadge);
      tr.appendChild(statusCell);

      tr.appendChild(cell(formatDate(u.createdAt)));

      var actions = document.createElement('td');
      actions.className = 'col-actions admin-only';
      if (isAdmin) {
        var wrap = document.createElement('div');
        wrap.className = 'row-actions';

        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'btn-link' + (u.status === 'active' ? ' danger' : '');
        toggle.textContent = u.status === 'active' ? '停用' : '启用';
        toggle.disabled = u.id === state.user.id;
        toggle.style.opacity = u.id === state.user.id ? '.45' : '';
        toggle.addEventListener('click', function () { toggleStatus(u); });

        var reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'btn-link';
        reset.textContent = '重置密码';
        reset.addEventListener('click', function () { openResetPassword(u); });

        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn-link danger';
        del.textContent = '删除';
        del.disabled = u.id === state.user.id;
        del.style.opacity = u.id === state.user.id ? '.45' : '';
        del.addEventListener('click', function () { deleteUser(u); });

        wrap.appendChild(toggle);
        wrap.appendChild(reset);
        wrap.appendChild(del);
        actions.appendChild(wrap);
      }
      tr.appendChild(actions);

      body.appendChild(tr);
    });
  }

  /* ---------------------------------------------------------------- */
  /* 记录操作                                                          */
  /* ---------------------------------------------------------------- */

  function submitRecord(event) {
    event.preventDefault();
    var tip = $('recordFormTip');
    tip.hidden = true;

    var payload = {
      steamId: withSteamSuffix($('rSteam').value),
      violationType: $('rType').value,
      handler: $('rHandler').value,
      handleTime: $('rTime').value,
      handleResult: $('rResult').value,
      remark: $('rRemark').value
    };

    api('/api/records', { method: 'POST', body: payload })
      .then(function () {
        $('recordForm').reset();
        $('rTime').value = nowForInput();
        state.page = 1;
        toast('记录已提交');
        return loadRecords();
      })
      .catch(function (err) {
        tip.textContent = err.message;
        tip.className = 'form-tip is-error';
        tip.hidden = false;
      });
  }

  function openEditRecord(record) {
    state.editingId = record.id;
    $('eSteam').value = stripSteamSuffix(record.steamId || '');
    $('eType').value = record.violationType || '';
    $('eHandler').value = record.handler || '';
    $('eTime').value = record.handleTime || '';
    $('eResult').value = record.handleResult || '';
    $('eRemark').value = record.remark || '';
    setError($('editError'), '');
    $('dlgRecord').showModal();
  }

  function saveEditRecord(event) {
    event.preventDefault();
    var payload = {
      steamId: withSteamSuffix($('eSteam').value),
      violationType: $('eType').value,
      handler: $('eHandler').value,
      handleTime: $('eTime').value,
      handleResult: $('eResult').value,
      remark: $('eRemark').value
    };

    api('/api/records/' + encodeURIComponent(state.editingId), { method: 'PUT', body: payload })
      .then(function () {
        $('dlgRecord').close();
        toast('记录已更新');
        return loadRecords();
      })
      .catch(function (err) {
        setError($('editError'), err.message);
      });
  }

  function deleteRecord(record) {
    var label = record.steamId + ' / ' + record.violationType;
    if (!window.confirm('确定删除这条记录吗？\n' + label + '\n删除后无法恢复。')) return;

    api('/api/records/' + encodeURIComponent(record.id), { method: 'DELETE' })
      .then(function () {
        toast('记录已删除');
        return loadRecords();
      })
      .catch(function (err) { toast(err.message, true); });
  }

  /* ---------------------------------------------------------------- */
  /* 账号操作                                                          */
  /* ---------------------------------------------------------------- */

  function openAddUser() {
    $('addUserForm').reset();
    setError($('userError'), '');
    $('dlgUser').showModal();
  }

  function submitAddUser(event) {
    event.preventDefault();
    var payload = {
      username: $('nuName').value,
      password: $('nuPass').value,
      role: $('nuRole').value
    };

    api('/api/users', { method: 'POST', body: payload })
      .then(function (user) {
        $('dlgUser').close();
        toast('已创建账号 ' + user.username);
        return loadUsers();
      })
      .catch(function (err) {
        setError($('userError'), err.message);
      });
  }

  function toggleStatus(user) {
    var next = user.status === 'active' ? 'disabled' : 'active';
    var word = next === 'disabled' ? '停用' : '启用';
    if (!window.confirm('确定' + word + '账号「' + user.username + '」吗？')) return;

    api('/api/users/' + encodeURIComponent(user.id), { method: 'PATCH', body: { status: next } })
      .then(function () {
        toast('已' + word + ' ' + user.username);
        return loadUsers();
      })
      .catch(function (err) { toast(err.message, true); });
  }

  function openResetPassword(user) {
    state.resetUserId = user.id;
    $('resetForm').reset();
    setError($('resetError'), '');
    $('resetTargetNote').textContent = '为「' + user.username + '」设置新密码，该账号在其他设备上会被强制退出。';
    $('dlgReset').showModal();
  }

  function submitResetPassword(event) {
    event.preventDefault();

    api('/api/users/' + encodeURIComponent(state.resetUserId) + '/password', {
      method: 'POST',
      body: { newPassword: $('resetPass').value }
    })
      .then(function () {
        $('dlgReset').close();
        toast('密码已重置');
      })
      .catch(function (err) {
        setError($('resetError'), err.message);
      });
  }

  function deleteUser(user) {
    if (!window.confirm('确定删除账号「' + user.username + '」吗？\n该账号将无法再登录。')) return;

    api('/api/users/' + encodeURIComponent(user.id), { method: 'DELETE' })
      .then(function () {
        toast('账号已删除');
        return loadUsers();
      })
      .catch(function (err) { toast(err.message, true); });
  }

  function submitPasswordChange(event) {
    event.preventDefault();
    var oldPassword = $('pwOld').value;
    var newPassword = $('pwNew').value;

    api('/api/me/password', { method: 'POST', body: { oldPassword: oldPassword, newPassword: newPassword } })
      .then(function () {
        $('dlgPassword').close();
        $('passwordForm').reset();
        toast('密码已修改，请用新密码重新登录');
        setTimeout(function () { forceLogout('密码已修改，请重新登录'); }, 1200);
      })
      .catch(function (err) {
        setError($('pwError'), err.message);
      });
  }

  /* ---------------------------------------------------------------- */
  /* 事件绑定                                                          */
  /* ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- */
  /* 视图切换：工作台 / 账号管理（账号管理仅管理员可进入）              */
  /* ---------------------------------------------------------------- */

  function openUserManage() {
    if (!state.user || state.user.role !== 'admin') {
      toast('你不是管理员，无法进入账号管理', true);
      return;
    }
    $('workspacePane').hidden = true;
    $('usersPane').hidden = false;
    loadUsers().catch(function (err) { toast(err.message, true); });
    window.scrollTo(0, 0);
  }

  function backToWorkspace() {
    $('usersPane').hidden = true;
    $('workspacePane').hidden = false;
    window.scrollTo(0, 0);
  }

  function bindEvents() {
    $('loginForm').addEventListener('submit', function (event) {
      event.preventDefault();
      login($('loginUser').value.trim(), $('loginPass').value, $('loginRemember').checked);
    });

    $('recordForm').addEventListener('submit', submitRecord);
    $('editRecordForm').addEventListener('submit', saveEditRecord);
    $('addUserForm').addEventListener('submit', submitAddUser);
    $('passwordForm').addEventListener('submit', submitPasswordChange);
    $('resetForm').addEventListener('submit', submitResetPassword);

    $('btnLogout').addEventListener('click', logout);
    $('btnAddUser').addEventListener('click', openAddUser);
    $('btnUserManage').addEventListener('click', openUserManage);
    $('btnBackWorkspace').addEventListener('click', backToWorkspace);

    $('btnChangePassword').addEventListener('click', function () {
      $('passwordForm').reset();
      setError($('pwError'), '');
      $('dlgPassword').showModal();
    });

    $('recordSearch').addEventListener('input', function (event) {
      state.search = event.target.value;
      state.page = 1;
      renderRecords();
    });

    $('pagePrev').addEventListener('click', function () {
      if (state.page > 1) { state.page -= 1; renderRecords(); }
    });

    $('pageNext').addEventListener('click', function () {
      state.page += 1;
      renderRecords();
    });

    // 所有弹窗的取消按钮
    document.querySelectorAll('[data-close]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var dlg = btn.closest('dialog');
        if (dlg) dlg.close();
      });
    });

    // 后端 401 之外的网络错误
    window.addEventListener('online', function () { toast('网络已恢复'); });
  }

  /* ---------------------------------------------------------------- */
  /* 内容防护：右键/快捷键/复制/打印/开发者工具/水印                    */
  /* ---------------------------------------------------------------- */

  function isFormField(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  function initProtection() {
    // 右键菜单
    document.addEventListener('contextmenu', function (event) {
      event.preventDefault();
    }, true);

    // 快捷键：F12 / Ctrl+Shift+I J C K / Ctrl+U 源码 / Ctrl+S 保存 / Ctrl+P 打印
    document.addEventListener('keydown', function (event) {
      var key = String(event.key || '').toLowerCase();
      if (event.keyCode === 123) { event.preventDefault(); return; }              // F12
      if (event.ctrlKey && event.shiftKey && ['i', 'j', 'c', 'k', 'e'].indexOf(key) !== -1) {
        event.preventDefault(); return;
      }
      if (event.ctrlKey && ['u', 's', 'p'].indexOf(key) !== -1) { event.preventDefault(); return; }
    }, true);

    // 复制 / 剪切 / 拖拽 / 划选：只允许在输入框内
    ['copy', 'cut', 'dragstart'].forEach(function (type) {
      document.addEventListener(type, function (event) {
        if (!isFormField(event.target)) {
          event.preventDefault();
          toast('禁止复制页面内容', true);
        }
      }, true);
    });

    document.addEventListener('selectstart', function (event) {
      if (!isFormField(event.target)) event.preventDefault();
    }, true);

    // PrintScreen：拦不住系统截图，只能尽量污染剪贴板
    document.addEventListener('keyup', function (event) {
      if (event.keyCode !== 44 && String(event.key || '') !== 'PrintScreen') return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText('青枫社区 · 本页面内容受保护，请勿截屏外传');
        }
      } catch (err) { /* 浏览器不允许时忽略 */ }
    }, true);

    // 开发者工具检测：判断窗口可视区是否被挤压
    var guard = $('devtoolsGuard');
    function checkDevtools() {
      var isOpen = (window.outerWidth - window.innerWidth > 170) ||
                   (window.outerHeight - window.innerHeight > 220);
      if (guard) guard.hidden = !isOpen;
      document.body.classList.toggle('is-blurred', isOpen);
    }
    checkDevtools();
    setInterval(checkDevtools, 800);
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /* 失焦遮罩：切到别的应用（含系统截图工具）时立刻模糊页面 */
  function initFocusShield() {
    var away = $('awayGuard');

    function blurNow() {
      document.body.classList.add('is-away');
      if (away) away.hidden = false;
    }

    function restoreNow() {
      document.body.classList.remove('is-away');
      if (away) away.hidden = true;
    }

    window.addEventListener('blur', blurNow);
    window.addEventListener('focus', restoreNow);

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) blurNow(); else restoreNow();
    });

    // 点击页面任意位置（或遮罩）都恢复
    document.addEventListener('pointerdown', function () {
      if (document.body.classList.contains('is-away')) {
        window.focus();
        restoreNow();
      }
    });
  }

  function updateWatermark() {
    var wm = $('wm');
    if (!wm || !state.user) return;

    var now = new Date();
    var timeText = pad2(now.getFullYear() % 100) + '/' + pad2(now.getMonth() + 1) + '/' +
      pad2(now.getDate()) + ' ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    var roleText = state.user.role === 'admin' ? '管理员' : '普通账号';
    var label = '用户:' + state.user.username + ' 时间:' + timeText + ' 权限:' + roleText;

    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="330" height="130">' +
      '<text x="14" y="78" fill="#0b0d10" font-size="12" font-family="sans-serif"' +
      ' transform="rotate(-14 165 65)">' + escapeXml(label) + '</text></svg>';

    wm.style.backgroundImage = 'url("data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(svg) + '")';
    wm.hidden = false;
  }

  function escapeXml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function hideWatermark() {
    var wm = $('wm');
    if (wm) wm.hidden = true;
  }

  /* ---------------------------------------------------------------- */
  /* 启动                                                              */
  /* ---------------------------------------------------------------- */

  function boot() {
    bindEvents();
    initProtection();
    initFocusShield();

    if (!state.token) {
      $('loginView').hidden = false;
      $('appView').hidden = true;
      return;
    }

    api('/api/me')
      .then(function (user) { enterApp(user); })
      .catch(function () { forceLogout(''); });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
