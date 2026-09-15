'use strict';

(function() {
  var _isOps = location.pathname.indexOf('mobile-ops') >= 0;
  var APP_VERSION = '1.1.0';

  var M = {
    currentTab: 'home',
    _currentAdminPage: null,
    currentUser: null,
    currentDeviceTab: 'glove',
    currentTicketFilter: 'all',
    currentOpsSub: 'submit',
    ticketList: [],
    machineList: [],
    snRegistry: [],
    _dataVersion: 0,
    _sse: null,

    _isSectionCollapsed(key) {
      return localStorage.getItem('m_section_'+key) === '1';
    },
    _toggleSection(key) {
      var collapsed = localStorage.getItem('m_section_'+key) === '1';
      collapsed = !collapsed;
      localStorage.setItem('m_section_'+key, collapsed ? '1' : '0');
      var list = document.getElementById('m-sec-'+key);
      var icon = document.getElementById('m-sec-icon-'+key);
      if (list) list.style.display = collapsed ? 'none' : '';
      if (icon) icon.textContent = collapsed ? '▶' : '▼';
    },

    _collapsibleSection(key, title, extra) {
      var collapsed = this._isSectionCollapsed(key);
      return '<div class="m-section-title" onclick="M._toggleSection(\''+key+'\')" style="cursor:pointer;">'+
        '<span id="m-sec-icon-'+key+'">'+(collapsed?'▶':'▼')+'</span> '+title+'</div>'+
        '<div id="m-sec-'+key+'" style="'+(collapsed?'display:none':'')+'">'+extra+'</div>';
    },

    async init() {
      // Mobile uses the dedicated Bearer-token session; web keeps HttpOnly cookies.
      API.clientMode = 'mobile';
      await API.init();
      if (!API.currentUser && !API.token) {
        if (_isOps) { location.replace('mobile.html'); return; }
        this._showLogin();
        return;
      }
      this.currentUser = API.currentUser;
      var userSys = API.currentUser.system || 'maintenance';
      if (!_isOps && userSys === 'operations' && API.currentUser.role !== 'superadmin') {
        location.replace('mobile-ops.html'); return;
      }
      if (_isOps && userSys === 'maintenance' && API.currentUser.role !== 'superadmin') {
        location.replace('mobile.html'); return;
      }
      this._showApp();
    },

    _showLogin(msg) {
      document.body.classList.add('login-mode');
      document.getElementById('m-login').style.display = 'flex';
      var app = document.getElementById('m-app');
      if (app) app.style.display = 'none';
      if (msg) { var e = document.getElementById('m-login-error'); if (e) e.textContent = msg; }
      this._fetchLoginUsers();
    },

    _showApp() {
      document.body.classList.remove('login-mode');
      var login = document.getElementById('m-login');
      if (login) login.style.display = 'none';
      var app = document.getElementById('m-app');
      if (app) app.style.display = 'flex';
      this.currentUser = API.currentUser;
      this._updateHeader();
      this._startSSE();
      this._loadCatLabels();

      this.switchTab('home');
    },

    _refreshCurrentTab() {
      if (!this.currentUser || document.hidden) return;
      var active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
      this._renderTab(this.currentTab, true);
    },

    _startSSE() {
      var self = this;
      if (self._sse) {
        try { self._sse.close(); } catch(e) {}
      }
      var base = API.baseURL || '';
      var url = base + '/api/events' + (API.token ? '?token=' + encodeURIComponent(API.token) : '');
      try {
        self._sse = new EventSource(url);
        var reload = function() {
          // One backend operation can emit several related events. Collapse the
          // burst so the mobile dashboard does not trip the per-user rate limit.
          if (self._sseReloadTimer) clearTimeout(self._sseReloadTimer);
          self._sseReloadTimer = setTimeout(function() {
            self._sseReloadTimer = null;
            if (!self.currentUser || document.hidden) return;
            self._dataVersion++;
            self._renderTab(self.currentTab, true);
            if (self.currentTab === 'admin' && self._currentAdminPage) {
              self.showAdminSubPage(self._currentAdminPage, true);
            }
          }, 300);
        };
        self._sse.addEventListener('data_changed', reload);
        self._sse.addEventListener('machines_updated', reload);
        self._sse.addEventListener('machine_presence_updated', reload);
        self._sse.addEventListener('machine_live_updated', function(e) {
          if (!_isOps) return;
          try { self._applyOpsMachineLive(JSON.parse(e.data || '{}')); } catch(err) {}
        });
        self._sse.addEventListener('inventory_updated', reload);
        self._sse.addEventListener('transactions_updated', reload);
        self._sse.addEventListener('sn_registry_updated', reload);
        self._sse.addEventListener('tech_support_updated', function() {
          self.ticketList = [];
        });
        self._sse.addEventListener('chat:message', function(e){
          try {
            var msg = JSON.parse(e.data);
            if (msg && msg.senderId && msg.senderId !== self._uid()) {
              self._appendChatMessage(msg);
              self._updateChatBadge();
            }
          } catch(err) {}
        });
        self._sse.onerror = function() {
          try { self._sse.close(); } catch(e) {}
          setTimeout(function() { self._startSSE(); }, 3000);
        };
      } catch(e) {}
    },

    async doLogin() {
      var u = document.getElementById('m-login-username');
      var p = document.getElementById('m-login-password');
      var username = u ? u.value.trim() : '';
      var password = p ? p.value.trim() : '';
      if (!username || !password) { this._lerr('请输入用户名和密码'); return; }
      var btn = document.getElementById('m-login-btn');
      if (btn) { btn.disabled = true; btn.textContent = '登录中...'; }
      var result = await API.login(username, password);
      if (!result.success) {
        this._lerr(result.message || '用户名或密码错误');
        if (btn) { btn.disabled = false; btn.textContent = '登 录'; }
        return;
      }
      this.currentUser = result.user;
      this._lerr('');
      var userSys = result.user.system || 'maintenance';
      if (!_isOps && userSys === 'operations' && result.user.role !== 'superadmin') {
        location.replace('mobile-ops.html'); return;
      }
      this._showApp();
      this.toast('欢迎，' + this._esc(result.user.username));
    },

    _lerr(msg) { var e = document.getElementById('m-login-error'); if (e) e.textContent = msg || ''; },

    async _fetchLoginUsers() {
      try {
        var users = await API._fetch('GET', '/api/auth/users');
        var datalist = document.getElementById('m-login-users');
        if (datalist && Array.isArray(users)) {
          datalist.innerHTML = users.map(function(u){ return '<option value="'+M._esc(u.username)+'">'; }).join('');
        }
      } catch(e){}
    },

    async doLogout() {
      var go = await this._askConfirm('确定退出当前账号？', '退出登录');
      if (!go) return;
      await API.logout();
      localStorage.removeItem('ops_machine_code');
      localStorage.removeItem('ops_locked_device_type');
      if (_isOps) { location.replace('mobile.html'); } else { location.reload(); }
    },

    switchTab(tab) {
      this.currentTab = tab;

      this.hideSubPageView();
      var tabs = document.querySelectorAll('.m-tab');
      for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].dataset.tab === tab);
      var panes = document.querySelectorAll('.m-tab-pane');
      for (var j = 0; j < panes.length; j++) panes[j].classList.remove('active');
      var pane = document.getElementById('m-tab-' + tab);
      if (pane) pane.classList.add('active');
      var titles = { home: _isOps ? '运营系统' : '首页', device: '设备', ticket: '技术支持', team: '团队', admin: '管理', me: '我的', messages: '消息' };
      var h = document.getElementById('m-header-title');
      if (h) h.textContent = titles[tab] || 'GMS';
      var fab = document.getElementById('m-fab');
      if (fab) fab.style.display = (tab === 'ticket') ? 'block' : 'none';
      this._renderTab(tab);
    },

    async _renderTab(tab, silent) {
      switch (tab) {
        case 'home': await (_isOps ? this.renderOpsDashboard(silent) : this.renderDashboard(silent)); break;
        case 'device': await this.renderDeviceTab(silent); break;
        case 'ticket': await (_isOps ? this.renderOpsTickets(silent) : this.renderTickets(silent)); break;
        case 'team': await this.renderTeamTab(silent); break;
        case 'admin': _isOps ? this.renderOpsAdminGrid() : this.renderAdminGrid(); break;
        case 'me': await this.renderProfile(); break;
      }
    },

    _updateHeader() {
      var header = document.getElementById('m-header');
      if (!header) return;

    },

    async renderDashboard(silent) {
      var wrap = document.getElementById('m-dashboard');
      if (!wrap) return;
      if (!silent) wrap.innerHTML = '<div class="m-loading">加载中...</div>';
      try {
        var _m = API.getMachines().catch(function(){return [];});
        var _i = API.getAllInventory().catch(function(){return [];});
        var _k = API.getTechSupportList().catch(function(){return [];});
        var _s = API.getSNRegistry().catch(function(){return [];});
        var machines = (await _m)||[], inventory = (await _i)||[], tickets = (await _k)||[], snList = (await _s)||[];
        this.machineList = machines;
        this.snRegistry = snList;

        var isGloveType = function(t){ return /glove/i.test(t||''); };
        var gloveQty = (inventory||[]).filter(function(i){ return isGloveType(i.type||i.equipmentType); })
          .reduce(function(s,i){ return s + (Number(i.quantity)||0); }, 0);
        var onlineCount = (machines||[]).filter(function(m){ var s=m.displayStatus||m.status||''; return s==='online'; }).length;
        var damagedCount = (snList||[]).filter(function(s){ return s.status==='damaged'; }).length;
        var transferredCount = (snList||[]).filter(function(s){ return s.status==='transferred'; }).length;
        var shippedCount = (snList||[]).filter(function(s){ return s.status==='shipped'; }).length;
        var isToday = function(t){ var d=new Date(t.createdAt||t.submittedAt||t.time||Date.now()); return d.toDateString()===new Date().toDateString(); };
        var pendingToday = (tickets||[]).filter(function(t){ return isToday(t) && (t.status==='pending'||t.status==='open'||t.status==='assigned'); }).length;
        var completedToday = (tickets||[]).filter(function(t){ var done=t.completedAt||t.resolvedAt; return (t.status==='completed'||t.status==='resolved'||t.status==='closed') && (done?new Date(done).toDateString()===new Date().toDateString():false); }).length;

        var replacements = []; try { replacements = await API.getReplacements(); } catch(e){}
        var inReplacement = replacements.filter(function(r){return r.status==='in_replacement';}).length;

        this._invList = inventory || [];
        await this._ensureWhList();
        var invHtml = this._buildInvSectionHtml();

        machines.sort(function(a, b) {
          var na = a.machineNumber||a.id||'-', nb = b.machineNumber||b.id||'-';
          var ma = na.match(/^(\D*)(\d+)$/), mb = nb.match(/^(\D*)(\d+)$/);
          if (ma && mb && ma[1] === mb[1]) return parseInt(ma[2],10) - parseInt(mb[2],10);
          return na.localeCompare(nb, 'zh-CN', {numeric:true});
        });
        var todayTickets = (tickets||[]).filter(function(t){ return isToday(t); });
        var byMachine = {};
        todayTickets.forEach(function(t){
          var k = t.machineNumber||t.machineId||'未知';
          if (!byMachine[k]) byMachine[k] = { num: k, count: 0, faults: {}, results: [] };
          byMachine[k].count++;
          var ft = t.faultType||'';
          if (ft) byMachine[k].faults[ft] = (byMachine[k].faults[ft]||0) + 1;
          if (t.repairResult) byMachine[k].results.push(t.repairResult);
        });
        var rankArr = Object.keys(byMachine).map(function(k){ return byMachine[k]; })
          .sort(function(a,b){ return b.count - a.count; }).slice(0,5);
        var rankHtml = rankArr.length ? rankArr.map(function(r){
          var faults = Object.keys(r.faults).map(function(f){ return f+(r.faults[f]>1?' ×'+r.faults[f]:''); }).join('、');
          var res = r.results.length ? '<div class="m-text-sm m-text-muted">维修：'+M._esc(r.results.join('；'))+'</div>' : '';
          return '<div class="m-data-row" style="cursor:pointer;" onclick="M._showMachineTicketsToday(\''+M._esc(r.num)+'\')"><div class="m-card-row"><div><div class="m-data-value">'+M._esc(r.num)+'</div>'+
            '<div class="m-data-label">'+M._esc(faults||'无故障类型')+'</div>'+res+'</div>'+
            '<div class="m-tx-qty">'+r.count+' 单</div></div></div>';
        }).join('') : '<div class="m-empty"><div class="m-empty-text">今日暂无技术支持</div></div>';
        this._todayTickets = todayTickets;
        wrap.innerHTML =
          '<div class="m-stat-grid-3">'+
            S.sc('手套库存', gloveQty, "M.showAdminSubPage('reports')")+
            S.sc('在线机器', onlineCount, "M.switchTab('device')")+
            S.sc('损坏手套', damagedCount, "M._showSNByStatus('damaged')")+
            S.sc('调出手套', transferredCount, "M._showSNByStatus('transferred')")+
            S.sc('寄出手套', shippedCount, "M._showSNByStatus('shipped')")+
            S.sc('置换中', inReplacement, "M.showAdminSubPage('replacement')")+
            S.sc('今日待响应', pendingToday, "M.switchTab('ticket')")+
            S.sc('今日完成', completedToday, "M.switchTab('ticket')")+
          '</div>'+
          '<div class="m-form-section" style="margin-top:10px;">'+
            '<div class="m-section-title" style="margin-top:0;">新版机器状态</div>'+
            '<div class="m-text-sm m-text-muted" style="margin-bottom:8px;">查看生产状态、运行日报和异常原因</div>'+
            '<button class="m-btn m-btn-primary m-btn-block" onclick="M.showAdminSubPage(\'machine-status\')">打开新版机器状态</button>'+ 
          '</div>'+
          '<div class="m-quick-grid-5">'+
            S.qj('SN码',function(){M.showAdminSubPage('sn-registry')})+
            S.qj('机器管理',function(){M.switchTab('device')})+
            S.qj('库存管理',function(){M.showAdminSubPage('reports')})+
            S.qj('置换管理',function(){M.showAdminSubPage('replacement')})+
            S.qj('帮助中心',function(){M.showHelpCenter()})+
          '</div>'+
          M._collapsibleSection('inv', '库存状态', invHtml)+
          M._collapsibleSection('rank', '今日技术支持排行榜', rankHtml);
      } catch(e) {
        wrap.innerHTML = '<div class="m-empty"><div class="m-empty-text">加载失败</div></div>';
      }
    },

    async _ensureWhList() {
      if (this._whList) return this._whList;
      var whs = [];
      try { whs = (await API.getWarehouses()) || []; } catch(e) { whs = []; }
      whs = whs.filter(function(w){ return w && w.status === 'active'; });
      this._whList = whs.length ? whs : [{ id: 'main', name: '主仓库' }];
      return this._whList;
    },

    _buildInvSectionHtml() {
      var whList = this._whList || [{ id: 'main', name: '主仓库' }];
      var whSel = this._whFilter || '';
      var opts = '<option value="">全部仓库</option>' + whList.map(function(w){
        return '<option value="'+M._esc(w.id)+'"'+(whSel===w.id?' selected':'')+'>'+M._esc(w.name)+'</option>';
      }).join('');
      var sel = '<div style="padding:0 0 8px;"><select class="m-select" onchange="M._setWhFilter(this.value)">'+opts+'</select></div>';
      var rows = (this._invList||[]).map(function(i){
        var name = M._invLabel(i.type||i.equipmentType);
        var qty = i.quantity||0;
        var sub;
        if (whSel) {
          var wr = (i.warehouses||[]).filter(function(w){ return w.warehouseId===whSel; })[0];
          qty = wr ? (wr.quantity||0) : 0;
          sub = '<div class="m-text-sm m-text-muted">该仓库数量</div>';
        } else {
          sub = '<div class="m-text-sm m-text-muted">可用 '+(i.available||0)+' · 使用中 '+(i.inUse||0)+' · 损坏 '+(i.damaged||0)+'</div>';
        }
        return '<div class="m-data-row"><div class="m-card-row"><div><div class="m-data-value">'+M._esc(name)+'</div>'+
          sub+'</div><div class="m-data-value">'+qty+'</div></div></div>';
      }).join('');
      return sel + (rows || '<div class="m-empty"><div class="m-empty-text">暂无库存数据</div></div>');
    },

    _setWhFilter(v) {
      this._whFilter = v || '';
      var sec = document.getElementById('m-sec-inv');
      if (sec) sec.innerHTML = this._buildInvSectionHtml();
    },

    _renderTx(list) {
      var wrap = document.getElementById('m-dashboard-tx');
      if (!wrap) return;
      var r = (list||[]).slice(0,5);
      if (!r.length) { wrap.innerHTML='<div class="m-empty"><div class="m-empty-text">暂无记录</div></div>'; return; }
      wrap.innerHTML = r.map(function(t){
        var time = M._fmtTime(t.timestamp||t.createdAt||t.time);
        var label = t.type||t.note||t.direction||'操作';
        var user = t.userName||t.user||t.operator||'';
        return '<div class="m-data-row"><div class="m-card-row"><div><div class="m-data-value">'+M._esc(label)+'</div><div class="m-data-label">'+M._esc(user)+' &middot; '+time+'</div></div><div class="m-text-sm m-text-muted">'+(t.quantity||t.amount||'')+'</div></div></div>';
      }).join('');
    },

    switchDeviceTab(type) {
      this.currentDeviceTab = type;
      var search = document.getElementById('m-device-search');
      if (search) search.value = '';
      this.renderDeviceTab();
    },
    _filterDeviceList() {
      var val = (document.getElementById('m-device-search')||{}).value||'';
      var items = this._deviceCache || [];
      if (!items.length) return;
      var wrap = document.getElementById('m-device-list');
      if (!wrap) return;
      var q = val.trim().toLowerCase();
      var filtered = q ? items.filter(function(i){ return (i.name||i.sn||'').toLowerCase().indexOf(q)>=0; }) : items;
      if (!filtered.length) { wrap.innerHTML = '<div class="m-empty"><div class="m-empty-text">未找到匹配结果</div></div>'; return; }
      wrap.innerHTML = filtered.map(function(i){ return i.html; }).join('');
    },
    async renderDeviceTab(silent) {
      var wrap = document.getElementById('m-device-list');
      if (!wrap) return;
      if (!silent) wrap.innerHTML = '<div class="m-loading">加载中...</div>';
      try {
        var machines = (await API.getMachines())||[];
        this.machineList = machines;
        var sn = (await API.getSNRegistry())||[];
        this.snRegistry = sn;
        var items = [];

        machines.sort(function(a, b) {
          var na = a.machineNumber||a.id||'-', nb = b.machineNumber||b.id||'-';
          var ma = na.match(/^(\D*)(\d+)$/), mb = nb.match(/^(\D*)(\d+)$/);
          if (ma && mb && ma[1] === mb[1]) return parseInt(ma[2],10) - parseInt(mb[2],10);
          return na.localeCompare(nb, 'zh-CN', {numeric:true});
        });
        machines.forEach(function(m){
          var num = m.machineNumber||m.id||'-';
          items.push({ name: num, type: 'machine', sn: num, html: M._buildMachineCard(m, sn) });
        });
        this._deviceCache = items;
        if (!items.length) { wrap.innerHTML = '<div class="m-empty"><div class="m-empty-text">暂无机器数据</div></div>'; return; }
        wrap.innerHTML = items.map(function(i){ return i.html; }).join('');
      } catch(e) {
        wrap.innerHTML = '<div class="m-empty"><div class="m-empty-text">加载失败</div></div>';
      }
    },
    _buildInvCard(item) {
      var name = this._invLabel(item.type||item.equipmentType);
      var qty = item.quantity||0;
      var av = item.available||0, iu = item.inUse||0, dmg = item.damaged||0, ir = item.inRepair||0, tr = item.transferred||0;
      var updated = this._fmtTime(item.updatedAt);
      var u = item.updatedBy||'-';
      var b = qty<=0?'<span class="m-badge m-badge-err">缺货</span>':(qty<5?'<span class="m-badge m-badge-wrn">低库存</span>':'<span class="m-badge m-badge-ok">充足</span>');
      return '<div class="m-device-card" data-inventory-type="'+this._esc(item.type||'')+'" onclick="M.showInventoryDetail(\''+this._esc(item.type||'')+'\')"><div class="m-device-header"><div class="m-device-name">'+this._esc(name)+'</div>'+b+'</div>'+
        '<div class="m-inv-breakdown">'+
          '<span class="m-inv-item m-inv-avail">可用 '+av+'</span>'+
          '<span class="m-inv-item m-inv-use">使用中 '+iu+'</span>'+
          '<span class="m-inv-item m-inv-dmg">损坏 '+dmg+'</span>'+
          '<span class="m-inv-item m-inv-repair">售后 '+ir+'</span>'+
          '<span class="m-inv-item m-inv-trans">已转出 '+tr+'</span>'+
        '</div>'+
        '<div class="m-device-meta">'+this._esc(u)+' &middot; '+updated+'</div></div>';
    },
    _buildMachineCard(m, snr) {
      var num = m.machineNumber||m.id||'-';
      var s = m.displayStatus||m.status||'offline';
      var si = this._machineSI(s);
      var leftSN = snr.filter(function(s){return s.machineNumber===num&&s.handType==='left'&&s.status==='in_use';});
      var rightSN = snr.filter(function(s){return s.machineNumber===num&&s.handType==='right'&&s.status==='in_use';});
      var lsn = leftSN.length?leftSN[0].snCode:null;
      var rsn = rightSN.length?rightSN[0].snCode:null;
      return '<div class="m-device-card" onclick="M.showMachineDetail(\''+this._esc(num)+'\')"><div class="m-device-header"><div class="m-device-name">'+this._esc(num)+'</div><span class="m-badge '+si.c+'">'+si.l+'</span></div>'+
        '<div class="m-device-info">左手：'+this._esc(lsn||'未绑定')+'</div>'+
        '<div class="m-device-info">右手：'+this._esc(rsn||'未绑定')+'</div>'+
      '</div>';
    },
    showMachineDetail(num) {
      var m = (this.machineList||[]).filter(function(x){return String(x.machineNumber||x.id)===String(num)})[0];
      var snr = this.snRegistry||[];
      if (!m) return;
      var s = m.displayStatus||m.status||'offline', si = this._machineSI(s);
      var leftSN = snr.filter(function(s){return s.machineNumber===num&&s.handType==='left'&&s.status==='in_use';});
      var rightSN = snr.filter(function(s){return s.machineNumber===num&&s.handType==='right'&&s.status==='in_use';});
      var lsn = leftSN.length?leftSN[0].snCode+(leftSN[0].source?' · '+M._esc(leftSN[0].source):''):'未绑定';
      var rsn = rightSN.length?rightSN[0].snCode+(rightSN[0].source?' · '+M._esc(rightSN[0].source):''):'未绑定';
      var fmt = function(d){ return d ? new Date(d).toLocaleString('zh-CN', {hour12:false}) : '-'; };
      var onlineTime = m.onlineTime || m.updatedAt || '';
      var todayTickets = (this._todayTickets||[]).filter(function(t){
        return (t.machineNumber||t.machineId||'') === num;
      });
      var ticketHtml = todayTickets.length ? todayTickets.map(function(t){
        var tsi = M._ticketSI(t.status);
        return '<div class="m-ticket-card" style="margin:4px 0;" onclick="M.showTicketDetail(\''+M._esc(t.id)+'\')"><div class="m-ticket-header"><div class="m-ticket-device" style="font-size:0.8rem;">'+M._esc(t.faultType||'-')+'</div><span class="m-badge '+tsi.c+'" style="font-size:0.7rem;">'+tsi.l+'</span></div><div class="m-ticket-desc" style="font-size:0.75rem;">'+M._esc(t.faultDescription||'')+'</div></div>';
      }).join('') : '<div style="font-size:0.8rem;color:var(--m-text-muted);padding:4px 0;">今日暂无工单</div>';
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">机器详情 · '+M._esc(num)+'</div><button class="m-modal-close" onclick="M.closeModal()">x</button></div>'+
        '<div class="m-form-section">'+
          '<div class="m-detail-row"><div class="m-detail-label">编号</div><div class="m-detail-value">'+M._esc(num)+'</div></div>'+
          '<div class="m-detail-row"><div class="m-detail-label">状态</div><div class="m-detail-value"><span class="m-badge '+si.c+'">'+si.l+'</span></div></div>'+
          '<div class="m-detail-row"><div class="m-detail-label">设备类型</div><div class="m-detail-value">'+M._esc(m.equipmentType||'-')+'</div></div>'+
          '<div class="m-detail-row"><div class="m-detail-label">上线时间</div><div class="m-detail-value">'+fmt(onlineTime)+'</div></div>'+
          '<div class="m-detail-row"><div class="m-detail-label">最后更新</div><div class="m-detail-value">'+fmt(m.updatedAt)+'</div></div>'+
          '<div class="m-detail-row"><div class="m-detail-label">左手</div><div class="m-detail-value">'+M._esc(lsn)+'</div></div>'+
          '<div class="m-detail-row"><div class="m-detail-label">右手</div><div class="m-detail-value">'+M._esc(rsn)+'</div></div>'+
          '<div class="m-detail-row" style="border-top:1px solid var(--m-border,#e5e7eb);margin-top:6px;padding-top:8px;"><div class="m-detail-label">今日工单 ('+todayTickets.length+')</div><div class="m-detail-value" style="display:block;width:100%;">'+ticketHtml+'</div></div>'+
        '</div>'+
         ((this.currentUser||{}).role === 'superadmin' ? '<div style="padding:12px 0 0;display:flex;gap:8px;justify-content:flex-end;"><button class="m-btn m-btn-danger" onclick="M._deleteMachine(\''+M._esc(m.id||'')+'\',\''+M._esc(num)+'\')">删除此机器</button></div>' : ''));
    },

    async _deleteMachine(id, num) {
      var go = await this._askConfirm('确认删除机器 <b>'+this._esc(num)+'</b>？此操作不可撤销！', '删除机器');
      if (!go) return;
      try {
        await API.deleteMachine(id);
        this.toast('机器已删除', 'ok');
        this.closeModal();
        this.renderDeviceTab();
      } catch(e) {
        this.toast('删除失败：'+(e.message||'未知错误'), 'err');
      }
    },

    switchTicketFilter(filter) {
      this.currentTicketFilter = filter;
      var btns = document.querySelectorAll('#m-tab-ticket .m-sub-tab');
      for (var i=0;i<btns.length;i++) btns[i].classList.toggle('active', btns[i].dataset.filter===filter);
      this._renderTicketList();
    },
    async renderTickets(silent) {
      var wrap = document.getElementById('m-ticket-list');
      if (!wrap) return;
      if (!silent) wrap.innerHTML = '<div class="m-loading">加载中...</div>';
      try { this.ticketList = (await API.getTechSupportList())||[]; this._renderTicketList(); }
      catch(e) { wrap.innerHTML = '<div class="m-empty"><div class="m-empty-text">加载失败</div></div>'; }
    },
    _renderTicketList() {
      var wrap = document.getElementById('m-ticket-list');
      var list = this.ticketList||[];
      var fm = {pending:['pending','open','assigned'],responded:['responded','in_progress','reopened'],completed:['completed','resolved','closed']};
      if (this.currentTicketFilter!=='all') { var a=fm[this.currentTicketFilter]||[]; list=list.filter(function(t){return a.indexOf(t.status)>=0;}); }
      if (!list.length) { wrap.innerHTML='<div class="m-empty"><div class="m-empty-text">暂无技术支持</div></div>'; return; }
      wrap.innerHTML = list.slice(0,100).map(function(t){
        var si = M._ticketSI(t.status);
        var dev = t.machineNumber||t.equipmentTypeName||t.machineId||'-';
        return '<div class="m-ticket-card" onclick="M.showTicketDetail(\''+M._esc(t.id)+'\')"><div class="m-ticket-header"><div class="m-ticket-device">'+M._esc(dev)+'</div><span class="m-badge '+si.c+'">'+si.l+'</span></div><div class="m-ticket-desc">'+M._esc(t.faultDescription||t.faultType||'')+'</div><div class="m-ticket-meta"><span>'+M._esc(t.submitterName||t.submitter||'-')+'</span><span>'+M._fmtTime(t.createdAt||t.submittedAt)+'</span></div></div>';
      }).join('');
    },
    async showTicketDetail(id) {
      this.openModal('<div class="m-loading">加载中...</div>');
      try {
        var t = await API.getTechSupportDetail(id)||(this.ticketList||[]).filter(function(x){return x.id===id})[0];
        if (!t) { this.closeModal(); return; }
        var si = this._ticketSI(t.status);
        var fields = [
          ['ID', t.id||'-'], ['状态', '<span class="m-badge '+si.c+'">'+si.l+'</span>'],
          ['设备', t.machineNumber||t.machineId||'-'], ['类型', t.equipmentTypeName||'-'],
          ['故障', t.faultType||'-'], ['描述', t.faultDescription||'-'],
          ['提交人', t.submitterName||t.submitter||'-'], ['时间', this._fmtTime(t.createdAt||t.submittedAt)]
        ];
        if (t.responderName) fields.push(['维修', t.responderName]);
        if (t.respondedAt) fields.push(['响应', this._fmtTime(t.respondedAt)]);
        if (t.resolvedAt||t.completedAt) fields.push(['完成', this._fmtTime(t.resolvedAt||t.completedAt)]);
        if (t.repairResult) fields.push(['结果', t.repairResult]);
        var checklistHtml = '';
        if (t.checklist) {
          var cm = [
            ['questConnected','Quest 连接'],['wristCamLConnected','左手腕相机连接'],['wristCamRConnected','右手腕相机连接'],
            ['wristPageLMatched','左手腕相机页面匹配'],['wristPageRMatched','右手腕相机页面匹配'],
            ['gloveLConnected','左手套连接'],['gloveRConnected','右手套连接'],['canProduce','可生产']
          ];
          checklistHtml = '<div class="m-form-section" style="padding-top:6px;"><div class="m-section-title" style="margin-bottom:6px;">设备确认检查</div>'+
            cm.map(function(c){ var v=t.checklist[c[0]]; var ok= v!==false&&v!=='no'&&v!=='false'; return '<div class="m-check-result-row"><div class="m-check-result-label">'+c[1]+'</div><div class="m-check-result-value '+(ok?'ok':'no')+'">'+(ok?'已确认':'异常')+'</div></div>'; }).join('')+
            '</div>';
        }
        var btns = '';
        if (t.status==='pending'||t.status==='open') btns += '<button class="m-btn m-btn-primary" onclick="M._respondTicket(\''+this._esc(t.id)+'\')">响应</button>';
        if (t.status==='responded'||t.status==='in_progress'||t.status==='reopened') btns += '<button class="m-btn m-btn-primary" onclick="M._showCompleteTicketModal(\''+this._esc(t.id)+'\')">完成</button>';
        this.openModal('<div class="m-modal-header"><div class="m-modal-title">技术支持详情</div><button class="m-modal-close" onclick="M.closeModal()">x</button></div>'+
          '<div class="m-form-section">'+fields.map(function(f){return '<div class="m-detail-row"><div class="m-detail-label">'+M._esc(f[0])+'</div><div class="m-detail-value">'+f[1]+'</div></div>';}).join('')+'</div>'+
          checklistHtml+
          (btns?'<div class="m-btn-row">'+btns+'<button class="m-btn m-btn-outline" onclick="M.closeModal()">关闭</button></div>':''));
      } catch(e) { this.openModal('<div class="m-empty"><div class="m-empty-text">加载失败</div></div>'); }
    },

    _showMachineTicketsToday(machineNum) {
      var self = this;
      var list = (this._todayTickets||[]).filter(function(t){
        return (t.machineNumber||t.machineId||'') === machineNum;
      });
      var body = list.length ? list.map(function(t){
        var si = M._ticketSI(t.status);
        return '<div class="m-ticket-card" onclick="M.showTicketDetail(\''+M._esc(t.id)+'\')"><div class="m-ticket-header"><div class="m-ticket-device">'+M._esc(t.machineNumber||t.machineId||'-')+'</div><span class="m-badge '+si.c+'">'+si.l+'</span></div><div class="m-ticket-desc">'+M._esc(t.faultDescription||t.faultType||'')+'</div><div class="m-ticket-meta"><span>'+M._esc(t.submitterName||t.submitter||'-')+'</span><span>'+M._fmtTime(t.createdAt||t.submittedAt)+'</span></div></div>';
      }).join('') : '<div class="m-empty"><div class="m-empty-text">今日暂无该机器工单</div></div>';
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">机器今日工单 · '+M._esc(machineNum)+'</div><button class="m-modal-close" onclick="M.closeModal()">x</button></div>'+
        '<div class="m-form-section">'+body+'</div><div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">关闭</button></div>');
    },
    _applyTicketLocalUpdate(item, id) {
      var found = false;
      for (var i = 0; i < this.ticketList.length; i++) {
        if (this.ticketList[i].id === id) { this.ticketList[i] = Object.assign(this.ticketList[i], item); found = true; break; }
      }
      if (!found) this.ticketList.unshift(item);
      if (_isOps) this._renderOpsTicketList();
      else this._renderTicketList();
    },
    async _respondTicket(id) {
      try {
        var r = await API.respondTechSupport(id);
        if (r && r.success !== false) {
          this.toast('已响应','ok');
          this.closeModal();
          if (r.item) this._applyTicketLocalUpdate(r.item, id);
          else this.renderTickets();
        } else this.toast((r && (r.error || r.message)) || '响应失败','err');
      } catch (e) { this.toast('响应失败，请稍后重试','err'); }
    },
    _showCompleteTicketModal(id) {
      var self = this;

      var items = [
        ['questConnected',  'Quest 是否连接'],
        ['wristCamLConnected', '左手腕相机是否连接'],
        ['wristCamRConnected', '右手腕相机是否连接'],
        ['wristPageLMatched',  '左手腕相机页面是否匹配'],
        ['wristPageRMatched',  '右手腕相机页面是否匹配'],
        ['gloveLConnected', '左手套是否连接'],
        ['gloveRConnected', '右手套是否连接']
      ];
      function sel(key, label, yesLabel, noLabel) {
        return '<div class="m-check-row"><div class="m-check-label">'+self._esc(label)+'</div>'+
          '<select class="m-select" id="m-cl-'+key+'" style="width:110px;flex-shrink:0;">'+
          '<option value="yes">'+self._esc(yesLabel)+'</option><option value="no">'+self._esc(noLabel)+'</option></select></div>';
      }
      var rows = items.map(function(it){
        var type = it[0];
        if (type.indexOf('Matched')>-1) return sel(type, it[1], '匹配', '不匹配');
        return sel(type, it[1], '已连接', '未连接');
      }).join('');
      rows += sel('canProduce', '是否能正常生产', '可以', '不可以');
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">维修完成确认</div><button class="m-modal-close" onclick="M.closeModal()">x</button></div>'+
        '<div class="m-form-section"><div class="m-section-title" style="margin-bottom:10px;">设备状态检查</div>'+
        rows +
        '<div class="m-field" style="margin-top:14px;"><label class="m-field-label">维修结果</label><textarea id="m-complete-result" class="m-textarea" placeholder="请填写维修结果"></textarea></div></div>'+
        '<div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">取消</button><button class="m-btn m-btn-primary" onclick="M._completeTicket(\''+this._esc(id)+'\')">确认完成</button></div>');
    },
    async _completeTicket(id) {
      var result = (document.getElementById('m-complete-result')||{}).value||'';
      if (!result) { this.toast('请填写维修结果','err'); return; }
      var clKeys = ['questConnected','wristCamLConnected','wristCamRConnected','wristPageLMatched','wristPageRMatched','gloveLConnected','gloveRConnected','canProduce'];
      var checklist = {};
      for (var i=0;i<clKeys.length;i++) {
        var el = document.getElementById('m-cl-'+clKeys[i]);
        checklist[clKeys[i]] = (el && el.value==='yes') ? true : false;
      }
      var extra = { checklist: checklist };
      try {
        var r = await API.completeTechSupport(id, result, extra);
        if (r && r.success !== false) {
          this.toast('已完成','ok');
          this.closeModal();
          if (r.item) this._applyTicketLocalUpdate(r.item, id);
          else this.renderTickets();
        } else this.toast((r && (r.error || r.message)) || '完成失败','err');
      } catch (e) { this.toast('完成失败，请稍后重试','err'); }
    },

    _tsCommonList: [
      { faultType: '连接失败', faultDescription: '设备使用中频繁断连/无法连接，已尝试重启软件和设备，问题仍存在。' },
      { faultType: '传感器异常', faultDescription: '手套/灵巧手某根手指数据无响应或明显漂移，动作不跟手，影响正常使用。' },
      { faultType: '闪退异常', faultDescription: '采集/操作软件运行中闪退，复现步骤：启动后进行常规操作即退出。' },
      { faultType: '无法启动', faultDescription: '设备上电/软件启动无反应，指示灯状态异常，已检查供电与网线连接。' },
      { faultType: '硬件损坏', faultDescription: '设备外观破损/线缆断裂/手指机构卡滞，需现场检修或更换。' },
      { faultType: '校准异常', faultDescription: '标定后姿态仍偏移，动作与实际手势不一致，重新标定无效。' },
    ],
    _tsFillCommon(i) {
      var e = (this._tsCommonList || [])[i];
      if (!e) return;
      var ft = document.getElementById('m-ts-faulttype');
      var fd = document.getElementById('m-ts-faultdesc');
      if (ft) ft.value = e.faultType;
      if (fd) fd.value = e.faultDescription;
    },
    _tsFillShared(i) {
      var e = (this._tsSharedFaults || [])[i];
      if (!e) return;
      var ft = document.getElementById('m-ts-faulttype');
      var fd = document.getElementById('m-ts-faultdesc');
      if (ft) ft.value = e.faultType;
      if (fd) fd.value = e.faultDescription;
    },

    _tsRenderCommonHtml() {
      var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">'+
        '<div style="font-size:0.75rem;font-weight:600;">📌 常见故障（点击填充，可再修改）</div>'+
        '<span onclick="M._tsAddCommon()" style="font-size:0.7rem;color:#1677ff;cursor:pointer;">＋ 保存当前填写为常见</span></div>'+
        '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
      for (var ci = 0; ci < this._tsCommonList.length; ci++) {
        html += '<span onclick="M._tsFillCommon('+ci+')" style="padding:5px 10px;border-radius:14px;background:#e6f4ff;color:#1677ff;font-size:0.72rem;cursor:pointer;border:1px solid #91caff;">'+this._esc(this._tsCommonList[ci].faultType)+'</span>';
      }
      var shared = this._tsSharedFaults || [];
      var me = this.currentUser || {};
      var myId = me.userId || me.id;
      for (var si = 0; si < shared.length; si++) {
        var f = shared[si];
        var canDel = me.role === 'superadmin' || !f.createdBy || f.createdBy === myId;
        var tip = f.createdByName ? (' title="由 '+f.createdByName+' 添加"') : '';
        html += '<span'+tip+' onclick="M._tsFillShared('+si+')" style="padding:5px 10px;border-radius:14px;background:#e6fffb;color:#08979c;font-size:0.72rem;cursor:pointer;border:1px solid #87e8de;">'+
          this._esc(f.faultType)+
          (canDel ? '<span onclick="event.stopPropagation();M._tsDelShared('+si+')" style="margin-left:5px;opacity:.55;">✕</span>' : '')+
          '</span>';
      }
      html += '</div>';
      return html;
    },
    async _tsAddCommon() {
      var ft = ((document.getElementById('m-ts-faulttype')||{}).value||'').trim();
      var fd = ((document.getElementById('m-ts-faultdesc')||{}).value||'').trim();
      if (!ft || !fd) { this.toast('请先填写故障类型和故障描述'); return; }
      try {
        var r = await API.addCommonFault({ faultType: ft, faultDescription: fd });
        if (r && r.success !== false && r.faults) {
          this._tsSharedFaults = r.faults;
          var wrap = document.getElementById('m-ts-common-wrap');
          if (wrap) wrap.innerHTML = this._tsRenderCommonHtml();
          this.toast('已保存，全运营账户可见','ok');
        } else {
          this.toast((r && (r.error || r.message)) || '保存失败','err');
        }
      } catch (e) { this.toast('保存失败，请稍后重试','err'); }
    },
    async _tsDelShared(i) {
      var f = (this._tsSharedFaults || [])[i];
      if (!f) return;
      if (!confirm('删除常见故障「'+f.faultType+'」？')) return;
      try {
        var r = await API.deleteCommonFault(f.id);
        if (r && r.success !== false && r.faults) {
          this._tsSharedFaults = r.faults;
          var wrap = document.getElementById('m-ts-common-wrap');
          if (wrap) wrap.innerHTML = this._tsRenderCommonHtml();
          this.toast('已删除','ok');
        } else {
          this.toast((r && (r.error || r.message)) || '删除失败','err');
        }
      } catch (e) { this.toast('删除失败，请稍后重试','err'); }
    },

    _tsFillHistory(i) {
      var e = (this._tsHistoryList || [])[i];
      if (!e) return;
      var ft = document.getElementById('m-ts-faulttype');
      var fd = document.getElementById('m-ts-faultdesc');
      if (ft) ft.value = e.faultType;
      if (fd) fd.value = e.faultDescription;
    },
    async showNewTicketForm() {
      if (!this.currentUser) return;
      var sys = this.currentUser.system||'';
      if (sys!=='operations'&&this.currentUser.role!=='superadmin') { this.toast('仅运营用户可提交'); return; }
      var mc = localStorage.getItem('ops_machine_code')||'';
      var lt = localStorage.getItem('ops_locked_device_type')||'';
      var tl = lt==='glove'?'手套':(lt||'');

      this._tsHistoryList = [];
      this._tsSharedFaults = [];
      try { this._tsHistoryList = (await API.getMyTechSupportHistory())||[]; } catch(e) {}

      try { this._tsSharedFaults = (await API.getCommonFaults())||[]; } catch(e) {}
      var histHtml = '';
      if (this._tsHistoryList.length) {
        histHtml = '<div style="margin-top:4px;"><div style="font-size:0.75rem;font-weight:600;margin-bottom:6px;">🕘 历史提交（点击填充）</div>';
        for (var hi = 0; hi < Math.min(20, this._tsHistoryList.length); hi++) {
          var he = this._tsHistoryList[hi];
          var shortDesc = he.faultDescription.length > 40 ? he.faultDescription.slice(0, 40) + '…' : he.faultDescription;
          histHtml += '<div onclick="M._tsFillHistory('+hi+')" style="padding:7px 10px;margin-bottom:6px;border:1px solid rgba(128,128,128,.25);border-radius:8px;background:rgba(128,128,128,.06);cursor:pointer;">'+
            '<span class="m-badge m-badge-dim" style="margin-right:6px;">'+this._esc(he.faultType)+'</span>'+
            '<span style="font-size:0.72rem;opacity:.8;">'+this._esc(shortDesc)+'</span></div>';
        }
        histHtml += '</div>';
      }

      var commonHtml = '<div id="m-ts-common-wrap" style="margin-top:4px;">'+this._tsRenderCommonHtml()+'</div>';
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">提交技术支持</div><button class="m-modal-close" onclick="M.closeModal()">x</button></div>'+
        '<div class="m-form-section">'+
          '<div class="m-field"><label class="m-field-label">设备编号</label><input id="m-ts-machineno" class="m-input" value="'+this._esc(mc)+'" placeholder="请输入设备编号" '+(mc?'readonly':'')+'></div>'+
          '<div class="m-field"><label class="m-field-label">设备类型</label><input id="m-ts-equipmenttype" class="m-input" value="'+this._esc(tl)+'" placeholder="如：手套 / 灵巧手" '+(lt?'readonly':'')+'></div>'+
          '<div class="m-field"><label class="m-field-label">故障类型</label><input id="m-ts-faulttype" class="m-input" placeholder="如：传感器异常"></div>'+
          '<div class="m-field"><label class="m-field-label">故障描述</label><textarea id="m-ts-faultdesc" class="m-textarea" placeholder="请详细描述故障现象"></textarea></div>'+
          commonHtml+
          histHtml+
        '</div>'+
        '<div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">取消</button><button class="m-btn m-btn-primary" onclick="M._submitTicket()">提交</button></div>');
    },
    async _submitTicket() {
      var mn = (document.getElementById('m-ts-machineno')||{}).value||'';
      var et = (document.getElementById('m-ts-equipmenttype')||{}).value||'';
      var ft = (document.getElementById('m-ts-faulttype')||{}).value||'';
      var fd = (document.getElementById('m-ts-faultdesc')||{}).value||'';
      if (!mn||!ft||!fd) { this.toast('请填写设备编号、故障类型和故障描述'); return; }
      var tm = {'wuji手套':'glove','灵巧手':'dexterous','夹爪':'gripper'};
      try {
        var r = await API.submitTechSupport({equipmentType:tm[et]||et||'glove',equipmentTypeName:et,machineId:mn,machineNumber:mn,faultType:ft,faultDescription:fd||ft});
        if (r && r.success !== false) {
          this.toast('已提交','ok'); this.closeModal(); if(_isOps)this.renderOpsTickets();else this.renderTickets();
        }
        else this.toast((r && (r.error || r.message)) || '提交失败','err');
      } catch (e) { this.toast('提交失败，请稍后重试','err'); }
    },

    async renderOpsDashboard(silent) {
      var wrap = document.getElementById('m-dashboard');
      if (!wrap) return;
      if (!silent) wrap.innerHTML = '<div class="m-loading">加载中...</div>';
      try {
        var pendingTickets = API.getTechSupportList().catch(function(){ return []; });
        var pendingMachines = API.getMachines().catch(function(){ return []; });
        var tickets = (await pendingTickets)||[];
        var machines = (await pendingMachines)||[];
        this._setOpsMachines(machines);
        var my = tickets.filter(function(t){
          var user = M.currentUser || {};
          return (t.submitterId && (t.submitterId === user.id || t.submitterId === user.userId)) ||
            (!t.submitterId && (t.submitterName||t.submitter||'') === (user.displayName || user.username));
        });
        var pend = tickets.filter(function(t){return t.status==='pending'||t.status==='open';});
        var today = tickets.filter(function(t){var d=new Date(t.createdAt||t.submittedAt);return d.toDateString()===new Date().toDateString();}).length;

        var replacements = []; try { replacements = await API.getReplacements(); } catch(e){}
        var inReplacement = replacements.filter(function(r){return r.status==='in_replacement';}).length;
        wrap.innerHTML =
          '<section class="m-live-panel" id="m-ops-live-panel">'+this._renderOpsMachinePanel()+'</section>'+
          '<div class="m-stat-grid">'+
            S.stat('总技术支持',tickets.length)+S.stat('待响应',pend.length)+
            S.stat('我的技术支持',my.length)+S.stat('今日提交',today)+
          '</div>'+
          '<div class="m-quick-grid">'+
            S.qi('提交技术支持',function(){M.showNewTicketForm()})+S.qi('我的技术支持',function(){M.switchTab('ticket');M.switchOpsTab('ticket','mine')})+
            S.qi('全部技术支持',function(){M.switchTab('ticket');M.switchOpsTab('ticket','all')})+S.qi('团队',function(){M.switchTab('team')})+
          '</div>'+
          '<div class="m-section-title">置换库存</div>'+
          '<div class="m-stat-grid-3">'+
            S.sm('置换中',inReplacement)+S.sm('已退回',replacements.filter(function(r){return r.status==='returned';}).length)+
            S.sm('已发厂家',replacements.filter(function(r){return r.status==='sent_to_manufacturer';}).length)+
          '</div>'+
          '<div style="margin-top:8px;">'+
            S.qi('置换管理',function(){M.switchTab('admin');M.showAdminSubPage('replacement')})+
          '</div>'+
          '<div class="m-section-title">最近技术支持</div>'+
          '<div id="m-dashboard-tx"></div>';
        this._renderTx(tickets.slice(0,5).map(function(t){return {type:t.faultType||t.faultDescription,userName:t.submitterName||t.submitter,timestamp:t.createdAt};}));
      } catch(e) { wrap.innerHTML = '<div class="m-empty"><div class="m-empty-text">加载失败</div></div>'; }
    },

    _setOpsMachines(machines) {
      var map = this._opsMachineMap || Object.create(null);
      (machines || []).forEach(function(machine) {
        var num = machine && (machine.machineNumber || machine.id);
        if (num) map[num] = Object.assign({}, map[num] || {}, machine);
      });
      this._opsMachineMap = map;
      if (!this._opsMachineFilter) this._opsMachineFilter = 'all';
      if (!this._opsMachineLimit) this._opsMachineLimit = 120;
    },

    _applyOpsMachineLive(update) {
      if (!update || !update.machineNumber) return;
      if (!this._opsMachineMap) this._opsMachineMap = Object.create(null);
      if (!this._opsLiveQueue) this._opsLiveQueue = Object.create(null);
      this._opsLiveQueue[update.machineNumber] = Object.assign(
        {}, this._opsLiveQueue[update.machineNumber] || {}, update
      );
      if (this._opsLiveFlushTimer) return;
      this._opsLiveFlushTimer = setTimeout(function() {
        M._opsLiveFlushTimer = null;
        var queued = M._opsLiveQueue || {};
        M._opsLiveQueue = Object.create(null);
        Object.keys(queued).forEach(function(num) {
          M._opsMachineMap[num] = Object.assign({}, M._opsMachineMap[num] || {}, queued[num]);
        });
        if (M.currentTab !== 'home' || document.hidden) return;
        var panel = document.getElementById('m-ops-live-panel');
        if (panel) panel.innerHTML = M._renderOpsMachinePanel();
      }, 100);
    },

    _isSNAdvisory(alert) {
      var code = String(alert && alert.code || '').trim().toLowerCase();
      return ['glove_no_sn', 'sn_unusable', 'sn_bound_elsewhere', 'unregistered_sn', 'hand_mismatch'].indexOf(code) >= 0
        || /(^|_)sn(_|$)/.test(code);
    },

    _opsMachineStatus(machine) {
      if (!machine || machine.hostOnline === false) return 'offline';
      if (machine.collectorStarted === false
        || (machine.edgeContainerRoleStatus && machine.edgeContainerRoleStatus.collector && machine.edgeContainerRoleStatus.collector.running === false)
        || (machine.containerRoleStatus && machine.containerRoleStatus.collector && machine.containerRoleStatus.collector.running === false)) return 'online_idle';
      var hermes = machine.hermes || {};
      var state = hermes.state || {};
      var health = hermes.health || {};
      var alerts = machine.edgeAlerts || machine.alerts || [];
      var hasOperationalError = state.emergencyStopped || Number(state.errorCount || 0) > 0
        || (Array.isArray(health.degraded) && health.degraded.length)
        || (Array.isArray(alerts) && alerts.some(function(a){ return a && !M._isSNAdvisory(a) && a.level === 'error'; }));
      if (hasOperationalError) return 'error';
      // 兼容旧快照：只有 SN 提示时忽略历史 runtimeStatus=error；无上下文的 error 仍保留。
      if (machine.runtimeStatus === 'error'
        && (!Array.isArray(alerts) || alerts.length === 0 || alerts.some(function(a){ return a && !M._isSNAdvisory(a); }))) return 'error';
      if (machine.runtimeStatus === 'recording') return 'recording';
      if (machine.runtimeStatus === 'offline') return 'offline';
      if (state.isRecording || state.controlState === 'RECORD') return 'recording';
      return machine.hostOnline === true ? 'online_idle' : 'offline';
    },

    _opsMachineNaturalSort(a, b) {
      return String(a.machineNumber || a.id || '').localeCompare(
        String(b.machineNumber || b.id || ''), 'zh-CN', { numeric: true, sensitivity: 'base' }
      );
    },

    _opsMachineSetFilter(status) {
      this._opsMachineFilter = status || 'all';
      this._opsMachineLimit = 120;
      var panel = document.getElementById('m-ops-live-panel');
      if (panel) panel.innerHTML = this._renderOpsMachinePanel();
    },

    _opsMachineSetTypeFilter(type) {
      this._opsMachineTypeFilter = type || 'all';
      this._opsMachineLimit = 120;
      var panel = document.getElementById('m-ops-live-panel');
      if (panel) panel.innerHTML = this._renderOpsMachinePanel();
    },

    _opsMachineSearch(value) {
      this._opsMachineQuery = value || '';
      this._opsMachineLimit = 120;
      var panel = document.getElementById('m-ops-live-panel');
      if (panel) panel.innerHTML = this._renderOpsMachinePanel(true);
      var input = document.getElementById('m-live-search');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    },

    _opsMachineMore() {
      this._opsMachineLimit = (this._opsMachineLimit || 120) + 100;
      var panel = document.getElementById('m-ops-live-panel');
      if (panel) panel.innerHTML = this._renderOpsMachinePanel();
    },

    _renderOpsMachinePanel() {
      var self = this;
      var STATUS = {
        recording: { label: '运行中', color: '#16a34a', icon: '●' },
        online_idle: { label: '空闲', color: '#1677ff', icon: '●' },
        error: { label: '异常', color: '#dc2626', icon: '!' },
        offline: { label: '离线', color: '#7d8da0', icon: '●' },
      };
      var order = ['error', 'recording', 'online_idle', 'offline'];
      var all = Object.keys(this._opsMachineMap || {}).map(function(k){
        var item = Object.assign({}, self._opsMachineMap[k]);
        item.machineNumber = item.machineNumber || k;
        item._liveStatus = self._opsMachineStatus(item);
        return item;
      }).sort(this._opsMachineNaturalSort);
      var counts = { recording:0, online_idle:0, error:0, offline:0 };
      all.forEach(function(m){ counts[m._liveStatus]++; });
      var filter = this._opsMachineFilter || 'all';
      var typeFilter = this._opsMachineTypeFilter || 'all';
      var query = String(this._opsMachineQuery || '').trim().toLowerCase();
      var filtered = all.filter(function(m){
        if (filter !== 'all' && m._liveStatus !== filter) return false;
        var machineType = m.machineType === 'glove_only' || m.deviceType === 'glove' ? 'glove_only'
          : (m.machineType === 'dexterous' || m.deviceType === 'dexterous') ? 'dexterous' : 'other';
        if (typeFilter !== 'all' && machineType !== typeFilter) return false;
        if (!query) return true;
        var task = m.task || (m.importer && m.importer.task) || {};
        var operator = task.operator || {};
        return [m.machineNumber, task.name, task.taskName, operator.name, operator.username]
          .some(function(v){ return String(v || '').toLowerCase().indexOf(query) >= 0; });
      });
      var limit = this._opsMachineLimit || 120;
      var shown = filtered.slice(0, limit);
      var byStatus = { recording:[], online_idle:[], error:[], offline:[] };
      shown.forEach(function(m){ byStatus[m._liveStatus].push(m); });

      var card = function(m) {
        var meta = STATUS[m._liveStatus];
        var task = m.task || (m.importer && m.importer.task) || null;
        var operator = task && task.operator ? task.operator : null;
        var prodStatus = m._liveStatus === 'recording' ? 'in_production' : (m.productionStatus || 'ready');
        var prod = {
          ready:'可生产', in_production:'在生产', waiting_repair:'待维修', testing:'在测试'
        }[prodStatus] || '可生产';
        var type = m.machineType === 'glove_only' ? '纯手套'
          : (m.machineType === 'dexterous' || m.deviceType === 'dexterous') ? '灵巧手' : '';
        var taskName = task && (task.name || task.taskName);
        var operatorName = operator && (operator.name || operator.displayName || operator.username);
        var details = [taskName ? '任务 '+self._esc(taskName) : '暂无任务', operatorName ? '操作员 '+self._esc(operatorName) : '', type, prod].filter(Boolean);
        var alertText = '';
        if (m._liveStatus === 'error') {
          var alerts = m.edgeAlerts || m.alerts || [];
          var first = Array.isArray(alerts) ? alerts.find(function(a){ return !self._isSNAdvisory(a); }) : null;
          alertText = first && first.message ? '<div class="m-live-card-alert">'+self._esc(first.message)+'</div>'
            : '<div class="m-live-card-alert">设备或采集程序异常</div>';
        }
        return '<button class="m-live-card m-live-'+m._liveStatus+'" onclick="M._msShowCollectorInfo(\''+self._esc(m.machineNumber)+'\')">'+
          '<div class="m-live-card-head"><span class="m-live-machine">'+self._esc(m.machineNumber)+'</span>'+ 
          '<span class="m-live-state-stack"><span class="m-live-production">'+prod+'</span><span class="m-live-state" style="color:'+meta.color+'"><i>'+meta.icon+'</i>'+meta.label+'</span></span></div>'+ 
          '<div class="m-live-card-meta">'+details.join('<span>·</span>')+'</div>'+alertText+'</button>';
      };
      var groups = order.map(function(status){
        if (!byStatus[status].length) return '';
        var meta = STATUS[status];
        return '<div class="m-live-group"><div class="m-live-group-title" style="color:'+meta.color+'">'+
          meta.label+' <span>'+byStatus[status].length+'</span></div><div class="m-live-grid">'+
          byStatus[status].map(card).join('')+'</div></div>';
      }).join('');
      if (!groups) groups = '<div class="m-empty"><div class="m-empty-text">暂无匹配机器</div></div>';
      var chip = function(key, label, count) {
        return '<button class="m-live-chip'+(filter===key?' active':'')+'" onclick="M._opsMachineSetFilter(\''+key+'\')">'+label+'<b>'+count+'</b></button>';
      };
      var typeChip = function(key, label) {
        return '<button class="m-live-chip'+(typeFilter===key?' active':'')+'" onclick="M._opsMachineSetTypeFilter(\''+key+'\')">'+label+'</button>';
      };
      return '<div class="m-live-head"><div><div class="m-live-title">机器实时状态</div>'+
        '<div class="m-live-sub"><span class="m-live-pulse"></span> 实时连接 · 状态变化约 2 秒更新</div></div>'+
        '<button class="m-live-open" onclick="M.showAdminSubPage(\'machine-status\')">完整状态</button></div>'+
        '<div class="m-live-summary">'+chip('all','全部',all.length)+chip('recording','运行',counts.recording)+
          chip('online_idle','空闲',counts.online_idle)+chip('error','异常',counts.error)+chip('offline','离线',counts.offline)+'</div>'+
        '<div class="m-live-summary m-live-type-summary">'+typeChip('all','全部类型')+typeChip('dexterous','灵巧手')+typeChip('glove_only','纯手套')+'</div>'+
        '<div class="m-live-search-wrap"><input id="m-live-search" class="m-live-search" placeholder="搜索机器、任务或操作员" value="'+self._esc(this._opsMachineQuery || '')+'" oninput="M._opsMachineSearch(this.value)"></div>'+
        '<div class="m-live-groups">'+groups+'</div>'+
        (filtered.length > shown.length ? '<button class="m-live-more" onclick="M._opsMachineMore()">继续显示（还有 '+(filtered.length-shown.length)+' 台）</button>' : '');
    },

    switchOpsTab(tab, sub) { this.currentOpsSub = sub; this.switchTab(tab); },
    async renderOpsTickets(silent) {
      var wrap = document.getElementById('m-ticket-content');
      if (!wrap) return;
      if (!silent) wrap.innerHTML = '<div class="m-loading">加载中...</div>';
      try {
        this.ticketList = (await API.getTechSupportList())||[];
        this._renderOpsTicketList();
      } catch(e) { wrap.innerHTML = '<div class="m-empty"><div class="m-empty-text">加载失败</div></div>'; }
    },
    _renderOpsTicketList() {
      var wrap = document.getElementById('m-ticket-content');
      if (!wrap) return;
      var btns = document.querySelectorAll('#m-tab-ticket .m-sub-tab');
      for (var i=0;i<btns.length;i++) btns[i].classList.toggle('active', btns[i].dataset.filter===this.currentOpsSub);
      var filtered = this.ticketList||[];
      if (this.currentOpsSub === 'mine') {
        var u = (this.currentUser||{}).username;
        var currentUser = this.currentUser || {};
        filtered = filtered.filter(function(t){
          return (t.submitterId && (t.submitterId === currentUser.id || t.submitterId === currentUser.userId)) ||
            (!t.submitterId && (t.submitterName||t.submitter||'') === (currentUser.displayName || u));
        });
      }
      if (!filtered.length) { wrap.innerHTML='<div class="m-empty"><div class="m-empty-text">暂无技术支持</div></div>'; return; }
      wrap.innerHTML = filtered.slice(0,100).map(function(t){
        var si = M._ticketSI(t.status);
        return '<div class="m-ticket-card" onclick="M.showTicketDetail(\''+M._esc(t.id)+'\')"><div class="m-ticket-header"><div class="m-ticket-device">'+M._esc(t.machineNumber||t.equipmentTypeName||'-')+'</div><span class="m-badge '+si.c+'">'+si.l+'</span></div><div class="m-ticket-desc">'+M._esc(t.faultDescription||t.faultType||'')+'</div><div class="m-ticket-meta"><span>'+M._esc(t.submitterName||t.submitter||'-')+'</span><span>'+M._fmtTime(t.createdAt||t.submittedAt)+'</span></div></div>';
      }).join('');
    },

    async renderTeamTab(silent) {
      var wrap = document.getElementById('m-team-content');
      if (!wrap) return;
      if (!silent) wrap.innerHTML = '<div class="m-loading">加载中...</div>';
      try {
        var users = []; try { users = await API.getUsers(); } catch(e){}
        if (!users||!users.length) { wrap.innerHTML='<div class="m-empty"><div class="m-empty-text">无法加载团队成员</div></div>'; return; }
        wrap.innerHTML = '<div class="m-section-title">团队成员 ('+users.length+')</div>'+users.slice(0,50).map(function(u){
          var ri = M._roleI(u.role);
          var initial = (u.username||'?')[0].toUpperCase();
          var colors = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899'];
          var bg = colors[Math.abs((u.username||'').length||0) % colors.length];
          return '<div class="m-list-item" style="cursor:pointer;" onclick="M._showMemberRepairStats(\''+M._esc(u.id)+'\',\''+M._esc(u.username)+'\')">'+
            '<div class="m-avatar-sm" style="background:'+bg+';color:#fff;">'+M._esc(initial)+'</div>'+
            '<div class="m-list-content"><div class="m-list-title">'+M._esc(u.displayName||u.username)+'</div><div class="m-list-sub">@'+M._esc(u.username)+' &middot; '+ri.l+'</div></div>'+
            '<div class="m-list-arrow">&rsaquo;</div></div>';
        }).join('');
      } catch(e) { wrap.innerHTML = '<div class="m-empty"><div class="m-empty-text">加载失败</div></div>'; }
    },

    _fmtDuration(seconds) {
      if (seconds == null) return '-';
      var s = Math.round(seconds);
      if (s < 60) return '<1分钟';
      var m = Math.round(s / 60);
      if (m < 60) return m + '分钟';
      var h = Math.floor(m / 60);
      var rm = m % 60;
      return rm > 0 ? h + '时' + rm + '分' : h + '小时';
    },
    _showMemberRepairStats(userId, userName, from, to) {
      var self = this;
      from = from || '';
      to = to || '';
      this.showSubPage('组员详情 · ' + userName, function(content){
        content.innerHTML = '<div class="m-loading">加载中...</div>';
        (async function(){
          try {
            var stats = await API.getMemberRepairStats(userId, from, to);
            if (!stats) { content.innerHTML = '<div class="m-empty"><div class="m-empty-text">暂无数据</div></div>'; return; }
            var fmt = function(d){ return d ? new Date(d).toLocaleString('zh-CN', {hour12:false}) : '-'; };
            var rows = (stats.history||[]).map(function(it){
              return '<div class="m-data-row"><div><div class="m-data-value">['+self._esc(it.machineNumber||'-')+'] '+self._esc(it.faultType||'-')+'</div><div class="m-data-label">'+fmt(it.submittedAt)+' 维修时长:'+self._fmtDuration(it.repairSeconds)+' 结果:'+self._esc(it.result||'-')+'</div></div></div>';
            }).join('') || '<div class="m-empty"><div class="m-empty-text">暂无维修记录</div></div>';
            content.innerHTML =
              '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:12px;background:var(--m-bg-card,#fff);border-radius:12px;margin-bottom:12px;">'+
                '<div style="text-align:center;padding:8px 0;"><div style="font-size:1.3rem;font-weight:700;color:#6366f1;">'+self._fmtDuration(stats.todayRepairSeconds)+'</div><div style="font-size:0.7rem;color:var(--m-text-muted);margin-top:2px;">今日维修时长</div></div>'+
                '<div style="text-align:center;padding:8px 0;"><div style="font-size:1.3rem;font-weight:700;color:#10b981;">'+self._fmtDuration(stats.filteredRepairSeconds)+'</div><div style="font-size:0.7rem;color:var(--m-text-muted);margin-top:2px;">历史维修时长</div></div>'+
                '<div style="text-align:center;padding:8px 0;"><div style="font-size:1.3rem;font-weight:700;color:#f59e0b;">'+stats.todayTechCount+'</div><div style="font-size:0.7rem;color:var(--m-text-muted);margin-top:2px;">今日技术支持</div></div>'+
              '</div>'+
              '<div style="display:flex;gap:6px;align-items:center;margin-bottom:10px;flex-wrap:wrap;">'+
                '<label style="font-size:0.75rem;color:var(--m-text-muted);">筛选：</label>'+
                '<input id="mr-from" type="date" value="'+self._esc(from)+'" style="flex:1;min-width:100px;padding:6px;border:1px solid var(--m-border,#e5e7eb);border-radius:8px;font-size:0.8rem;">'+
                '<span style="color:var(--m-text-muted);font-size:0.8rem;">至</span>'+
                '<input id="mr-to" type="date" value="'+self._esc(to)+'" style="flex:1;min-width:100px;padding:6px;border:1px solid var(--m-border,#e5e7eb);border-radius:8px;font-size:0.8rem;">'+
                '<button class="m-btn-sm" style="padding:6px 12px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:0.8rem;" onclick="M._applyMemberFilter()">筛选</button>'+
                '<button class="m-btn-sm" style="padding:6px 12px;background:var(--m-bg,#f5f5f5);color:#333;border:1px solid var(--m-border,#e5e7eb);border-radius:8px;font-size:0.8rem;" onclick="M._resetMemberFilter()">重置</button>'+
              '</div>'+
              '<div id="m-member-history" style="background:var(--m-bg-card,#fff);border-radius:12px;overflow:hidden;">'+
                '<div style="padding:10px 14px;font-size:0.85rem;font-weight:600;border-bottom:1px solid var(--m-border,#e5e7eb);">维修记录 ('+((stats.history||[]).length)+')</div>'+
                '<div style="max-height:360px;overflow-y:auto;">'+rows+'</div>'+
              '</div>';
            self._memberUserId = userId;
          } catch(e) { content.innerHTML = '<div class="m-empty"><div class="m-empty-text">加载失败</div></div>'; }
        })();
      });
    },
    _applyMemberFilter() {
      var from = document.getElementById('mr-from')?.value || '';
      var to = document.getElementById('mr-to')?.value || '';
      this._showMemberRepairStats(this._memberUserId, '');
    },
    _resetMemberFilter() {
      this._showMemberRepairStats(this._memberUserId, '');
    },

    renderOpsAdminGrid() { this._renderAdminGrid('m-ops-admin-grid'); },
    renderAdminGrid() { this._renderAdminGrid('m-admin-grid'); },
    _renderAdminGrid(id) {
      var wrap = document.getElementById(id);
      if (!wrap) return;
      var role = (this.currentUser||{}).role;

      var items = [
        {label:'流水',page:'transactions',desc:'设备出入库记录',icon:'T',sys:'mnt'},
        {label:'审计',page:'audit',desc:'系统操作日志追溯',icon:'A',a:true,sys:'both'},
        {label:'SN码',page:'sn-registry',desc:'手套SN码注册管理',icon:'S',sys:'mnt'},
        {label:'售后',page:'after-sales',desc:'售后维修记录管理',icon:'R',sys:'mnt'},
        {label:'报表',page:'reports',desc:'库存与技术支持统计',icon:'B',sys:'both'},
        {label:'设置',page:'settings',desc:'系统配置与参数',icon:'G',a:true,sys:'both'},
        {label:'用户',page:'users',desc:'账号与权限管理',icon:'U',a:true,sys:'ops'},
        {label:'消息',page:'popup',desc:'弹窗消息管理',icon:'M',a:true,sys:'ops'},
        {label:'SOP',page:'sop',desc:'SOP 文档管理',icon:'S',a:true,sys:'both'},
        {label:'方案',page:'solutions',desc:'解决方案库',icon:'F',a:true,sys:'both'},
        {label:'置换',page:'replacement',desc:'手套置换库存管理',icon:'H',a:true,sys:'mnt'},
        {label:'库位',page:'storage-locations',desc:'库位管理与设备分配',icon:'K',sys:'mnt'},
        {label:'库存配置',page:'inventory-config',desc:'动态添加和管理物品库存',icon:'K',a:true,sys:'mnt'},
        {label:'机器管理',page:'machines',desc:'机器上线/下线与手套绑定',icon:'🖥',sys:'mnt'},
        {label:'机器状态',page:'machine-status',desc:'生产状态可视化与变更',icon:'📈',sys:'both'},
        {label:'SN链接',page:'sn-links',desc:'SN状态查询链接管理',icon:'🔗',sys:'mnt'},
        {label:'机器链接',page:'machine-links',desc:'机器状态查询链接管理',icon:'🧭',sys:'mnt'},
        {label:'设备配置',page:'equipment-config',desc:'设备类型与消耗配置',icon:'🔧',a:true,sys:'mnt'},
        {label:'今日首检',page:'shift-inspection',desc:'早班晚班首检状态',icon:'✓',sys:'mnt'},
        {label:'发货单',page:'delivery-notes',desc:'售后/置换发货记录',icon:'📦',a:true,sys:'mnt'},
        {label:'服务器',page:'server-status',desc:'服务器状态与连接池监控',icon:'⚡',a:true,sys:'both'}
      ].filter(function(i){

        if (_isOps) { if (i.sys !== 'ops' && i.sys !== 'both') return false; }
        else { if (i.sys !== 'mnt' && i.sys !== 'both') return false; }

        if (!i.a || role === 'admin' || role === 'superadmin') return true;
        return false;
      });
      wrap.innerHTML = '<div class="m-admin-grid-2">'+items.map(function(i){
        return '<div class="m-admin-card" onclick="M.showAdminSubPage(\''+i.page+'\')"><div class="m-admin-card-icon">'+i.icon+'</div><div class="m-admin-card-label">'+M._esc(i.label)+'</div><div class="m-admin-card-desc">'+M._esc(i.desc)+'</div></div>';
      }).join('')+'</div>';
    },

    async showAdminSubPage(page, silent) {
      this._currentAdminPage = page;

      var _ADMIN_ONLY = {audit:1,settings:1,users:1,popup:1,sop:1,solutions:1,replacement:1,'inventory-config':1,'equipment-config':1,'delivery-notes':1,'server-status':1};
      var _role = (this.currentUser||{}).role;
      if (_ADMIN_ONLY[page] && _role !== 'admin' && _role !== 'superadmin') {
        this.toast('无权限访问该功能', 'err');
        return;
      }
      var titles = {transactions:'流水记录',audit:'审计日志','sn-registry':'SN注册表','after-sales':'售后记录',reports:'统计报表',settings:'系统设置',users:'用户管理',popup:'弹窗消息',sop:'SOP文档',solutions:'解决方案库',replacement:'置换库存','storage-locations':'库位管理','inventory-config':'库存配置','shift-inspection':'今日首检','delivery-notes':'发货单','server-status':'服务器看板',machines:'机器管理','machine-status':'机器状态','sn-links':'SN链接管理','machine-links':'机器链接管理','equipment-config':'设备类型配置'};
      var view = document.getElementById('m-subpage-view');
      var content = document.getElementById('m-subpage-content');
      if (view) view.style.display = 'flex';
      this._bindSubPageSwipe(view);
      if (content && !silent) {
        content.innerHTML = '<div class="m-subpage-title">'+(titles[page]||page)+'</div><div class="m-loading">加载中...</div>';
      }
      try {
        switch(page) {
          case 'transactions': await this._renderTransactions(content); break;
          case 'audit': await this._renderAudit(content); break;
          case 'sn-registry': await this._renderSN(content); break;
          case 'after-sales': await this._renderAfterSales(content); break;
          case 'reports': await this._renderReports(content); break;
          case 'users': await this._renderUsers(content); break;
          case 'settings': await this._renderSettings(content); break;
          case 'popup': await this._renderPopupMessages(content); break;
          case 'sop': await this._renderSOP(content); break;
          case 'solutions': await this._renderSolutions(content); break;
          case 'replacement': await this._renderReplacement(content); break;
          case 'storage-locations': await this._renderStorageLocations(content); break;
          case 'inventory-config': await this._renderInventoryConfig(content); break;
          case 'shift-inspection': await this._renderShiftInspectionPage(content); break;
          case 'delivery-notes': await this._renderDeliveryNotes(content); break;
          case 'server-status': await this._renderServerDashboard(content); break;
          case 'machines': await this._renderMachinesPage(content); break;
          case 'machine-status': await this._renderMachineStatusPage(content); break;
          case 'sn-links': await this._renderSNLinks(content); break;
          case 'machine-links': await this._renderMachineLinks(content); break;
          case 'equipment-config': await this._renderEquipmentConfig(content); break;
          default: if (content) content.innerHTML = '<div class="m-empty"><div class="m-empty-text">该功能正在移动端完善中</div></div>';
        }
      } catch(e) { if (content) content.innerHTML = '<div class="m-empty"><div class="m-empty-text">加载失败</div></div>'; }
    },
    hideSubPageView() {
      var view = document.getElementById('m-subpage-view');
      if (view) view.style.display = 'none';

      this._currentAdminPage = null;

      if (this._svTimer) { clearInterval(this._svTimer); this._svTimer = null; }

      var cf = document.getElementById('m-chat-float');
      if (cf) cf.style.display = 'flex';
    },

    showSubPage(title, renderFn) {
      var view = document.getElementById('m-subpage-view');
      var content = document.getElementById('m-subpage-content');
      if (view) view.style.display = 'flex';
      this._bindSubPageSwipe(view);
      if (content) content.innerHTML = '<div class="m-subpage-title">'+this._esc(title)+'</div><div class="m-loading">加载中...</div>';
      if (typeof renderFn === 'function') renderFn(content);

      var cf = document.getElementById('m-chat-float');
      if (cf) cf.style.display = 'none';
    },

    _bindSubPageSwipe(view) {
      if (!view || view._swipeBound) return;
      view._swipeBound = true;
      var startX = 0, startY = 0, startTs = 0;
      view.addEventListener('touchstart', function(e){
        var t = e.touches[0];
        startX = t.clientX; startY = t.clientY; startTs = Date.now();
      }, { passive: true });
      view.addEventListener('touchmove', function(e){

        var t = e.touches[0];
        var dx = t.clientX - startX, dy = t.clientY - startY;
        if (startX <= 32 && dx > 0 && Math.abs(dx) > Math.abs(dy)) e.preventDefault();
      }, { passive: false });
      view.addEventListener('touchend', function(e){
        var t = e.changedTouches[0];
        var dx = t.clientX - startX, dy = t.clientY - startY;
        var dt = Date.now() - startTs;

        if (startX <= 32 && dx > 60 && Math.abs(dx) > Math.abs(dy)*1.5) {
          M.hideSubPageView();
        }
      }, { passive: true });
    },
    async _renderTransactions(wrap) {
      var list = await API.getTransactions(100);
      if (!list||!list.length) { wrap.innerHTML='<div class="m-empty"><div class="m-empty-text">暂无流水</div></div>'; return; }
      wrap.innerHTML = list.slice(0,50).map(function(t){
        var time = M._fmtTime(t.timestamp||t.createdAt||t.time);
        var eqLabel = t.equipmentType ? M._invLabel(t.equipmentType) : '';
        var dirLabel = t.direction === 'in' ? '入库' : t.direction === 'out' ? '出库' : '';
        var handLabel = t.handType === 'left' ? '左手' : t.handType === 'right' ? '右手' : '';
        var note = t.note || t.type || '';
        var id = t.id || ('tx-'+Math.random().toString(36).slice(2,8));
        var detailId = 'm-tx-detail-'+id.replace(/[^a-zA-Z0-9_-]/g,'');
        return '<div class="m-tx-row" onclick="M._toggleTxDetail(\''+M._esc(id)+'\',\''+M._esc(detailId)+'\')">'+
          '<div class="m-tx-main"><div class="m-tx-left"><div class="m-tx-type">'+M._esc(note||dirLabel||'操作')+'</div>'+
          '<div class="m-tx-meta">'+M._esc(t.updatedBy||t.userName||t.user||'')+' &middot; '+time+'</div></div>'+
          '<div class="m-tx-right">'+(t.quantity?'<span class="m-tx-qty">'+t.quantity+'</span>':'')+'</div></div>'+
          '<div class="m-tx-detail" id="'+M._esc(detailId)+'" style="display:none">'+
            (eqLabel?'<div class="m-tx-dl"><span class="m-tx-dt">设备</span><span class="m-tx-dd">'+eqLabel+(handLabel?' - '+handLabel:'')+'</span></div>':'')+
            (dirLabel?'<div class="m-tx-dl"><span class="m-tx-dt">方向</span><span class="m-tx-dd">'+dirLabel+'</span></div>':'')+
            (t.snCode?'<div class="m-tx-dl"><span class="m-tx-dt">SN码</span><span class="m-tx-dd">'+M._esc(t.snCode)+'</span></div>':'')+
            (t.machineNumber?'<div class="m-tx-dl"><span class="m-tx-dt">机器</span><span class="m-tx-dd">'+M._esc(t.machineNumber)+'</span></div>':'')+
            (note?'<div class="m-tx-dl"><span class="m-tx-dt">备注</span><span class="m-tx-dd">'+M._esc(note)+'</span></div>':'')+
            '<div class="m-tx-dl"><span class="m-tx-dt">时间</span><span class="m-tx-dd">'+time+'</span></div>'+
            '<div class="m-tx-dl"><span class="m-tx-dt">操作人</span><span class="m-tx-dd">'+M._esc(t.updatedBy||t.userName||t.user||'')+'</span></div>'+
          '</div></div>';
      }).join('');
    },
    _toggleTxDetail(id, detailId) {
      var el = document.getElementById(detailId);
      if (!el) return;

      var all = document.querySelectorAll('.m-tx-detail');
      for (var i=0;i<all.length;i++) { if (all[i].id !== detailId) all[i].style.display = 'none'; }
      el.style.display = el.style.display === 'none' ? 'block' : 'none';
    },
    async _renderAudit(wrap) {
      var list = await API.getAuditLog();
      if (!list||!list.length) { wrap.innerHTML='<div class="m-empty"><div class="m-empty-text">暂无审计日志</div></div>'; return; }
      wrap.innerHTML = list.slice(0,50).map(function(a){
        return '<div class="m-data-row"><div><div class="m-data-value">'+M._esc(a.action||a.operation||'操作')+'</div><div class="m-data-label">'+M._esc(a.user||a.userName||'')+' &middot; '+M._fmtTime(a.timestamp||a.createdAt||a.time)+'</div></div></div>';
      }).join('');
    },
    async _renderSN(wrap) {
      var list = await API.getSNRegistry();
      if (!list||!list.length) { wrap.innerHTML='<div class="m-empty"><div class="m-empty-text">暂无SN码</div></div>'; return; }
      wrap.innerHTML = list.slice(0,60).map(function(s){
        var si = M._snSI(s.status);
        var sn = s.snCode||s.sn||s.id;
        var srcHtml = s.source ? ' &middot; 来源:'+M._esc(s.source) : '';
        var locHtml = s.location_code ? ' &middot; 库位:'+M._esc(s.location_code) : '';
        return '<div class="m-device-card" onclick="M._showSNDetail(\''+M._esc(sn)+'\')"><div class="m-device-header"><div class="m-device-name">'+M._esc(sn)+'</div><span class="m-badge '+si.c+'">'+si.l+'</span></div><div class="m-device-info">'+M._esc(s.equipmentType||'-')+(s.handType?' &middot; '+(s.handType==='left'?'左手':'右手'):'')+srcHtml+locHtml+'</div>'+(s.machineNumber?'<div class="m-device-info">绑定：'+M._esc(s.machineNumber)+'</div>':'')+'<div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="event.stopPropagation();M.showSNAction(\''+M._esc(sn)+'\',\''+M._esc(s.status||'')+'\')">状态操作</button><button class="m-btn m-btn-outline" onclick="event.stopPropagation();M._showMobileLocationPicker(\''+M._esc(sn)+'\')">分配库位</button></div></div>';
      }).join('');
    },

    _showSNDetail(snCode) {
      var list = this.snRegistry && this.snRegistry.length ? this.snRegistry : (Storage.getSNRegistry() || []);
      var s = list.filter(function(x){return (x.snCode||x.sn||x.id)===snCode;})[0] || { snCode: snCode };
      var si = this._snSI(s.status);
      var fmt = function(d){ return d ? new Date(d).toLocaleString('zh-CN',{hour12:false}) : '-'; };
      var hand = s.handType ? (s.handType==='left'?'左手':s.handType==='right'?'右手':s.handType) : '-';
      var row = function(k,v){ return '<div class="m-detail-row"><div class="m-detail-label">'+k+'</div><div class="m-detail-value">'+(v===null||v===undefined||v===''?'-':v)+'</div></div>'; };
      var locName = '';
      var locs = Storage.getStorageLocations ? (Storage.getStorageLocations()||[]) : [];
      for (var i=0;i<locs.length;i++){ if(locs[i].code===s.location_code){ locName=locs[i].name||''; break; } }
      var locVal = s.location_code ? M._esc(s.location_code)+(locName?' · '+M._esc(locName):'') : '-';
      this.openModal(
        '<div class="m-modal-header"><div class="m-modal-title">SN详情</div><button class="m-modal-close" onclick="M.closeModal()">×</button></div>'+
        '<div class="m-form-section">'+
          row('SN码','<span style="font-family:monospace;font-weight:600;">'+M._esc(snCode)+'</span>')+
          row('状态','<span class="m-badge '+si.c+'">'+si.l+'</span>')+
          row('来源', M._esc(s.source||''))+
          row('设备类型', M._invLabel(s.equipmentType))+
          row('手型', hand)+
          row('库位', locVal)+
          row('绑定机器', M._esc(s.machineNumber||''))+
          row('破坏原因', M._esc(s.damageReason||''))+
          row('物流单号', M._esc(s.trackingNumber||''))+
          row('创建时间', fmt(s.createdAt))+
          row('最后更新', fmt(s.updatedAt))+
        '</div>'+
        '<div class="m-sn-history"><div class="m-sn-history-title">状态历史</div><div id="m-sn-history-'+M._esc(snCode)+'">加载中...</div></div>'+
        '<div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">关闭</button><button class="m-btn m-btn-outline" onclick="M._showMobileLocationPicker(\''+M._esc(snCode)+'\')">分配库位</button><button class="m-btn m-btn-primary" onclick="M.showSNAction(\''+M._esc(snCode)+'\',\''+M._esc(s.status||'')+'\')">状态操作</button></div>'
      );

      this._loadSNHistory(snCode);
    },
    async _loadSNHistory(snCode) {
      var el = document.getElementById('m-sn-history-'+snCode);
      if (!el) return;
      var hist = [];
      try {
        var data = await API._fetch('GET', '/api/sn-registry/'+encodeURIComponent(snCode)+'/history');
        hist = (data && data.history) ? data.history : [];
      } catch(e) { hist = []; }
      if (!el) return;
      if (!hist.length) { el.innerHTML = '<div class="m-sn-history-empty">暂无状态历史</div>'; return; }
      var dotMap = {available:'c-ok',in_use:'c-info',inUse:'c-info',damaged:'c-err',in_repair:'c-wrn',inRepair:'c-wrn',transferred:'c-dim',shipped:'c-wrn',repaired:'c-ok',scrapped:'c-err'};
      el.innerHTML = '<ul class="m-sn-hl">' + hist.slice(0,10).map(function(h){
        var dotCls = dotMap[h.newStatus] || 'c-dim';
        var from = h.oldStatusLabel ? M._esc(h.oldStatusLabel) + '<span class="m-sn-hl-arrow">→</span>' : '';
        var to = '<span class="m-sn-hl-new">' + M._esc(h.newStatusLabel || h.newStatus || '') + '</span>';
        var time = M._fmtTime(h.createdAt);
        var operator = h.operator ? M._esc(h.operator) : '';
        var machine = h.machineNumber ? M._esc(h.machineNumber) : '';
        var subParts = [];
        if (operator) subParts.push(operator);
        subParts.push(time);
        if (machine) subParts.push(machine);
        var sub = subParts.join(' · ');
        var reasonHtml = h.reason ? '<div class="m-sn-hl-sub"><span class="m-sn-hl-reason">' + M._esc(h.reason) + '</span></div>' : '';
        return '<li class="m-sn-hl-item"><span class="m-sn-hl-dot '+dotCls+'"></span><div class="m-sn-hl-body"><div class="m-sn-hl-line">'+from+to+'</div><div class="m-sn-hl-sub">'+sub+'</div>'+reasonHtml+'</div></li>';
      }).join('') + '</ul>';
    },
    showSNAction(sn, status) {
      var options = status === 'damaged' ? '<option value="in_repair">送售后</option><option value="available">恢复可用</option>' : status === 'in_repair' || status === 'inRepair' ? '<option value="available">维修完成回库</option><option value="damaged">标记损坏</option>' : '<option value="damaged">标记损坏</option><option value="in_repair">送售后</option>';
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">SN状态操作</div><button class="m-modal-close" onclick="M.closeModal()">×</button></div><div class="m-form-section"><div class="m-detail-row"><div class="m-detail-label">SN码</div><div class="m-detail-value">'+this._esc(sn)+'</div></div><div class="m-field"><label class="m-field-label">新状态</label><select id="m-sn-status" class="m-select">'+options+'</select></div><div class="m-field"><label class="m-field-label">原因</label><input id="m-sn-reason" class="m-input" placeholder="填写状态变更原因"></div></div><div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">取消</button><button class="m-btn m-btn-primary" onclick="M._submitSNAction(\''+this._esc(sn)+'\')">确认</button></div>');
    },
    async _submitSNAction(sn) {
      var status = document.getElementById('m-sn-status').value;
      var reason = (document.getElementById('m-sn-reason').value||'').trim();
      try {

        var tracking = '';
        if (status === 'in_repair') {
          tracking = await this._askText('多个手套可共用同一单号', '请输入快递单号', '快递单号（可选）');
          if (tracking === null) return;
        }
        var result = await API.changeSNStatus({ snCode: sn, newStatus: status, reason: reason, machineNumber: '', trackingNumber: tracking || '' });
        if (!result || result.success === false) { this.toast((result&& (result.error||result.message)) || '状态更新失败', 'err'); return; }
        this.closeModal(); this.toast('SN状态已更新', 'ok');

        if (status === 'in_repair') {
          var snData = (this.snRegistry || []).find(function(s) { return (s.snCode||s.sn||s.id) === sn; });
          var items = [{snCode: sn, eqLabel: M._invLabel(snData ? snData.equipmentType : 'glove'), handLabel: (snData && snData.handType === 'right') ? '右手' : '左手', equipmentType: snData ? snData.equipmentType : 'glove', handType: snData ? snData.handType : 'left', reason: reason}];
          var dn = await API.saveDeliveryNote({ type: 'repair', items: items, trackingNumber: tracking || '' });
          if (dn && dn.success) {
            var dop = await this._askConfirm('发货单已保存，是否立即打印？', '打印发货单');
            if (dop) {
              M._printDeliveryNote(dn.id);
            }
          }
        }
        this.showAdminSubPage('sn-registry');
      } catch (e) { this.toast('网络错误，请稍后重试', 'err'); }
    },

    async _showSNByStatus(status) {
      var labels = {damaged:'损坏手套',transferred:'调出手套',shipped:'寄出手套',available:'库存手套',in_use:'使用中手套'};
      var label = labels[status] || status;
      var self = this;
      self.showSubPage(label, async function(content) {
        content.innerHTML = '<div class="m-loading">加载中...</div>';
        try {
          var list = await API.getSNRegistry();
          var filtered = (list||[]).filter(function(s){ return s.status === status; });
          if (!filtered.length) {
            content.innerHTML = '<div class="m-empty" style="padding:60px 20px"><div class="m-empty-text">暂无'+M._esc(label)+'</div></div>';
            return;
          }
          content.innerHTML = filtered.map(function(s){
            var si = M._snSI(s.status);
            var sn = s.snCode||s.sn||s.id;
            var srcHtml = s.source ? ' · 来源:'+M._esc(s.source) : '';
            var locHtml = s.location_code ? ' · 库位:'+M._esc(s.location_code) : '';
            return '<div class="m-device-card" onclick="M._showSNDetail(\''+M._esc(sn)+'\')">'+
              '<div class="m-device-header"><div class="m-device-name">'+M._esc(sn)+'</div><span class="m-badge '+si.c+'">'+si.l+'</span></div>'+
              '<div class="m-device-info">'+M._esc(s.equipmentType||'-')+(s.handType?' · '+(s.handType==='left'?'左手':'右手'):'')+srcHtml+locHtml+'</div>'+
              (s.machineNumber?'<div class="m-device-info">绑定：'+M._esc(s.machineNumber)+'</div>':'')+
              '</div>';
          }).join('');
        } catch(e) {
          content.innerHTML = '<div class="m-empty"><div class="m-empty-text">加载失败</div></div>';
        }
      });
    },

    _showMobileLocationPicker: async function(snCode) {
      var locs = Storage.getStorageLocations() || [];
      var sns = Storage.getSNRegistry() || [];
      var sn = sns.find(function(s) { return (s.snCode||s.sn||s.id) === snCode; });
      var currentLoc = sn ? (sn.location_code || '') : '';
      var options = '<option value="">-- 无库位 --</option>';
      locs.forEach(function(l) {
        var sel = l.code === currentLoc ? 'selected' : '';
        options += '<option value="'+M._esc(l.code)+'" '+sel+'>'+M._esc(l.code)+(l.name?' · '+M._esc(l.name):'')+'</option>';
      });
      var noLocMsg = locs.length === 0 ? '<div style="font-size:0.78rem;color:#d97706;padding:8px 0;">暂无库位，请先在桌面端库位管理中添加</div>' : '';
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">分配库位</div><button class="m-modal-close" onclick="M.closeModal()">x</button></div>'+
        '<div class="m-form-section"><div class="m-detail-row"><div class="m-detail-label">SN码</div><div class="m-detail-value" style="font-family:monospace;font-weight:600;">'+this._esc(snCode)+'</div></div>'+
        '<div class="m-field"><label class="m-field-label">库位</label><select id="m-loc-picker" class="m-select">'+options+'</select></div>'+noLocMsg+
        '</div><div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">取消</button><button class="m-btn m-btn-primary" onclick="M._submitMobileLocationAssign(\''+this._esc(snCode)+'\')">保存</button></div>');
    },
    _submitMobileLocationAssign: async function(snCode) {
      var location_code = (document.getElementById('m-loc-picker')?.value||'');
      try {
        var result = await API.upsertSNRegistry({ snCode: snCode, location_code: location_code });
        if (!result || result.success === false) {
          this.toast((result && (result.error || result.message)) || '保存失败', 'err');
          return;
        }
        this.closeModal();
        this.toast(location_code ? '已分配至库位 '+location_code : '已清除库位', 'ok');
        this.showAdminSubPage('sn-registry');
      } catch (e) { this.toast('保存失败，请稍后重试', 'err'); }
    },
    async _renderAfterSales(wrap) {
      var self = this;
      this._asSel = this._asSel || {};
      this._asBar = null;
      var list = (await API.getSNRegistry() || []).filter(function(s) { return s.status === 'damaged' || s.status === 'in_repair' || s.status === 'inRepair'; });
      if (!list.length) { wrap.innerHTML='<div class="m-empty"><div class="m-empty-text">暂无售后记录</div></div>'; return; }
      var h = '<div class="m-subpage-title">售后记录</div>';
      h += '<div style="margin-bottom:12px;display:flex;gap:8px;align-items:center;justify-content:space-between;">' +
        '<span style="font-size:0.8rem;color:var(--muted);">共 ' + list.length + ' 条</span>' +
        '<button type="button" class="m-btn m-btn-outline" onclick="M._toggleAfterSalesBatch(this)" style="font-size:0.75rem;padding:8px 10px;flex-shrink:0;">批量</button>' +
        '</div>';
      h += '<div id="m-as-list">';
      for (var i = 0; i < Math.min(list.length, 60); i++) {
        var s = list[i];
        var si = M._snSI(s.status);
        var sn = s.snCode||s.sn||s.id;
        h += '<div class="m-device-card"><div class="m-device-header"><div class="m-device-name">'+M._esc(sn)+'</div><span class="m-badge '+si.c+'">'+si.l+'</span></div><div class="m-device-info">'+M._invLabel(s.equipmentType)+(s.damageReason?' · '+M._esc(s.damageReason):'')+'</div><div class="m-btn-row" style="display:flex;gap:6px;">' +
          '<button type="button" class="m-btn m-btn-primary as-sel-btn" data-sn="'+M._esc(sn)+'" style="display:none;flex:1;" onclick="M._asToggleItemBtn(this,\''+M._esc(sn)+'\')">选择</button>' +
          '<button type="button" class="m-btn m-btn-primary as-proc-btn" data-sn="'+M._esc(sn)+'" data-status="'+M._esc(s.status||'')+'" style="flex:1;" onclick="M.showSNAction(\''+M._esc(sn)+'\',\''+M._esc(s.status||'')+'\')">处理</button>' +
          '</div></div>';
      }

      h += '<div style="display:none;position:sticky;bottom:10px;background:var(--bg-card);padding:10px 12px;border-radius:10px;box-shadow:0 -2px 10px rgba(0,0,0,.08);margin-top:10px;gap:8px;" id="m-as-batch-bar">' +
        '<button type="button" class="m-btn m-btn-sm m-btn-outline" onclick="M._asSelectAll()" style="flex:1;">全选/取消</button>' +
        '<button type="button" class="m-btn m-btn-sm" onclick="M._batchShipAfterSales()" style="background:var(--color-primary);color:#fff;flex:1.2;">售后</button>' +
        '</div>';
      wrap.innerHTML = h;

      this._asBar = document.getElementById('m-as-batch-bar');

      if (this._asBatch) {
        if (this._asBar) this._asBar.style.display = 'flex';
        var selBtns = wrap.getElementsByClassName('as-sel-btn');
        for (var j = 0; j < selBtns.length; j++) {
          selBtns[j].style.display = 'block';
          if (this._asSel && this._asSel[selBtns[j].getAttribute('data-sn')]) {
            selBtns[j].textContent = '已选';
            selBtns[j].style.background = '#22c55e';
          }
        }
        var btns = wrap.getElementsByClassName('m-btn-outline');
        for (var bi = 0; bi < btns.length; bi++) {
          if (btns[bi].textContent === '批量') { btns[bi].textContent = '取消'; btns[bi].style.background = 'var(--danger)'; btns[bi].style.color = '#fff'; break; }
        }
      }
    },

    _toggleAfterSalesBatch(btn) {
      this._asBatch = !this._asBatch;
      var show = this._asBatch;
      if (!show) this._asSel = {};
      if (btn) { btn.textContent = show ? '取消' : '批量'; btn.style.background = show ? 'var(--danger)' : ''; btn.style.color = show ? '#fff' : ''; }
      var selBtns = document.getElementsByClassName('as-sel-btn');
      for (var si = 0; si < selBtns.length; si++) selBtns[si].style.display = show ? 'block' : 'none';
      if (this._asBar) this._asBar.style.display = show ? 'flex' : 'none';
      this.toast(show ? '批量模式已开启，点【选择】勾选设备' : '已退出批量模式');
    },

    _asToggleItemBtn(btn, sn) {
      this._asSel = this._asSel || {};
      var has = !!this._asSel[sn];
      if (has) delete this._asSel[sn];
      else this._asSel[sn] = true;
      btn.textContent = has ? '选择' : '已选';
      btn.style.background = has ? 'var(--color-primary)' : '#22c55e';
      var cnt = Object.keys(this._asSel).length;
      this.toast((has ? '已取消：' + sn : '已选：' + sn) + '（共 '+cnt+' 个）', has ? '' : 'ok');
    },
    _asSelectAll() {
      var selBtns = document.getElementsByClassName('as-sel-btn');
      if (!selBtns.length) return;
      var allSel = true;
      for (var si = 0; si < selBtns.length; si++) { if (selBtns[si].textContent !== '已选') allSel = false; }
      var want = !allSel;
      this._asSel = this._asSel || {};
      if (want) {
        for (si = 0; si < selBtns.length; si++) {
          var sn = selBtns[si].getAttribute('data-sn');
          if (sn) this._asSel[sn] = true;
        }
      } else this._asSel = {};
      for (si = 0; si < selBtns.length; si++) {
        selBtns[si].textContent = want ? '已选' : '选择';
        selBtns[si].style.background = want ? '#22c55e' : 'var(--color-primary)';
      }
      this.toast(want ? '已全选 ' + selBtns.length + ' 个 SN' : '已取消全选', 'ok');
    },
    async _batchShipAfterSales() {
      var sels = Object.keys(this._asSel || {});
      if (!sels.length) { this.toast('请先选择要送售后的 SN', 'err'); return; }
      var tracking = await this._askText('多个 SN 可共用同一单号', '请输入快递单号', '快递单号（可选）');
      if (tracking === null) return;
      var go = await this._askConfirm('确认将 <b>'+sels.length+'</b> 个损坏 SN 送售后（发货给厂家维修）？', '批量送售后');
      if (!go) return;
      var ok = 0, fail = 0, firstErr = '';
      for (var i = 0; i < sels.length; i++) {
        var r = await API.changeSNStatus({ snCode: sels[i], newStatus: 'in_repair', reason: '售后', machineNumber: '', trackingNumber: tracking || '' });
        if (r && r.success !== false) ok++;
        else { fail++; if (!firstErr) firstErr = r?.error || '操作失败'; }
      }
      if (ok > 0) {
        this.toast('已送售后 ' + ok + ' 个 SN');

        var all = await API.getSNRegistry();
        var items = [];
        sels.forEach(function(sn) {
          var row = (all||[]).find(function(x) { return (x.snCode||x.sn||x.id) === sn; });
          items.push({ snCode: sn, eqLabel: M._invLabel(row ? row.equipmentType : 'glove'), handLabel: row && row.handType === 'right' ? '右手' : '左手', equipmentType: row ? row.equipmentType : 'glove', handType: row ? row.handType : 'left', reason: (row && row.damageReason) || '' });
        });
        var dn = await API.saveDeliveryNote({ type: 'repair', items: items, trackingNumber: tracking || '' });
        if (dn && dn.success) {
          var dop = await this._askConfirm('发货单已保存，是否立即打印？', '打印发货单');
          if (dop) {
            M._printDeliveryNote(dn.id);
          }
        }
      }
      if (fail > 0) this.toast(fail + ' 个失败' + (firstErr ? '：' + firstErr : ''), 'err');
      this._asBatch = false; this._asSel = {};
      this._renderAfterSales(document.getElementById('m-subpage-content'));
    },
    async _renderReports(wrap) {
      var inventory = await API.getAllInventory();
      var sn = await API.getSNRegistry();
      var tickets = await API.getTechSupportList();
      var total = (inventory||[]).reduce(function(sum, x) { return sum + (Number(x.quantity)||0); }, 0);
      var available = (inventory||[]).reduce(function(sum, x) { return sum + (Number(x.available)||0); }, 0);
      var damaged = (sn||[]).filter(function(x) { return x.status === 'damaged'; }).length;
      var repair = (sn||[]).filter(function(x) { return x.status === 'in_repair' || x.status === 'inRepair'; }).length;
      var pending = (tickets||[]).filter(function(x) { return x.status === 'pending' || x.status === 'open'; }).length;
      var pct = total ? Math.round(available/total*100) : 0;
      var bar = '<div style="height:8px;background:var(--muted-bg);border-radius:4px;overflow:hidden;margin:8px 0"><div style="height:100%;width:'+pct+'%;background:var(--primary);border-radius:4px;transition:width 0.3s"></div></div>';
      wrap.innerHTML = '<div class="m-stat-grid">'+S.stat('库存总量', total)+S.stat('可用数量', available)+S.stat('损坏设备', damaged)+S.stat('售后设备', repair)+S.stat('待处理', pending)+S.stat('技术支持总量', (tickets||[]).length)+'</div><div class="m-form-section"><div class="m-section-title">库存状态</div>'+bar+'<div class="m-card-row"><span class="m-text-sm m-text-muted">可用率 '+pct+'%</span><span class="m-text-sm m-text-muted">损坏 '+damaged+' · 售后 '+repair+'</span></div></div>';
    },
    async _renderUsers(wrap) {
      var list = [];
      try { list = await API.getUsers(); } catch(e){}
      if (!list||!list.length) { wrap.innerHTML='<div class="m-empty"><div class="m-empty-text">暂无用户</div></div>'; return; }
      var isAdmin = (this.currentUser||{}).role === 'admin' || (this.currentUser||{}).role === 'superadmin';
      var self = this;
      wrap.innerHTML = list.slice(0,50).map(function(u){
          var ri = M._roleI(u.role);
          var uid = u.id || u.userId || u.username;
          var delBtn = isAdmin && u.role !== 'superadmin' && uid !== (self.currentUser||{}).userId
            ? '<button class="m-btn m-btn-outline" style="color:#ef4444;border-color:#ef4444;margin-left:6px;" onclick="M._deleteUserConfirm(\''+M._esc(uid)+'\',\''+M._esc(u.displayName||u.username)+'\')">删除</button>'
            : '';
          return '<div class="m-list-item"><div class="m-list-icon">'+ri.i+'</div><div class="m-list-content"><div class="m-list-title">'+M._esc(u.displayName||u.username)+'</div><div class="m-list-sub">@'+M._esc(u.username)+' &middot; '+ri.l+'</div></div><div style="display:flex;gap:4px;flex-shrink:0;">'+delBtn+'<button class="m-btn m-btn-outline" onclick="M.showUserPassword(\''+M._esc(uid)+'\')">重置密码</button></div></div>';
        }).join('');
    },
    _deleteUserConfirm(userId, username) {
      var self = this;
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">删除用户</div><button class="m-modal-close" onclick="M.closeModal()">×</button></div><div class="m-form-section"><p style="font-size:0.85rem;color:var(--text2);line-height:1.6;">确定删除用户 <b>'+this._esc(username)+'</b>？<br>此操作不可恢复，请谨慎操作。</p></div><div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">取消</button><button class="m-btn m-btn-primary" style="background:#ef4444;border-color:#ef4444;" onclick="M._doDeleteUser(\''+this._esc(userId)+'\',\''+this._esc(username)+'\')">确认删除</button></div>');
    },
    async _doDeleteUser(userId, username) {
      var r = await API.deleteUser(userId);
      if (r && r.success !== false) {
        this.toast('用户 '+username+' 已删除','ok');
        this.closeModal();
        this.showAdminSubPage('users');
      } else {
        this.toast((r && (r.error || r.message)) || '删除失败','err');
      }
    },
    showUserPassword(userId) {
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">重置用户密码</div><button class="m-modal-close" onclick="M.closeModal()">×</button></div><div class="m-form-section"><div class="m-field"><label class="m-field-label">新密码</label><input id="m-user-new-password" class="m-input" type="password" placeholder="至少6位，包含字母和数字"></div><div class="m-field"><label class="m-field-label">确认密码</label><input id="m-user-confirm-password" class="m-input" type="password" placeholder="再次输入新密码"></div></div><div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">取消</button><button class="m-btn m-btn-primary" onclick="M._submitUserPassword(\''+this._esc(userId)+'\')">保存</button></div>');
    },
    async _submitUserPassword(userId) {
      var password = document.getElementById('m-user-new-password').value || '';
      var confirmPassword = document.getElementById('m-user-confirm-password').value || '';
      if (password.length < 6 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) { this.toast('密码至少6位，且需包含字母和数字', 'err'); return; }
      if (password !== confirmPassword) { this.toast('两次密码不一致', 'err'); return; }
      var result = await API.resetPassword(userId, password);
      if (!result || result.success === false) { this.toast((result && (result.error || result.message)) || '密码重置失败', 'err'); return; }
      this.closeModal(); this.toast('密码重置成功', 'ok');
    },
    async _renderSettings(wrap) {
      var s = await API.getSettings();
      if (!s) { wrap.innerHTML='<div class="m-empty"><div class="m-empty-text">无法加载设置</div></div>'; return; }
      wrap.innerHTML = '<div class="m-form-section"><div class="m-field"><label class="m-field-label">系统名称</label><input id="m-setting-name" class="m-input" value="'+this._esc(s.systemName||s.appName||'GMS')+'"></div><div class="m-field"><label class="m-field-label">主题</label><select id="m-setting-theme" class="m-select"><option value="light"'+(s.theme==='light'?' selected':'')+'>浅色</option><option value="dark"'+(s.theme==='dark'?' selected':'')+'>深色</option><option value="system"'+(s.theme==='system'?' selected':'')+'>跟随系统</option></select></div><div class="m-detail-row"><div class="m-detail-label">通知</div><label><input id="m-setting-notify" type="checkbox"'+(s.enableNotifications?' checked':'')+'> 启用</label></div><div class="m-detail-row"><div class="m-detail-label">实时同步</div><label><input id="m-setting-sse" type="checkbox"'+(s.enableSSE!==false?' checked':'')+'> 启用</label></div></div><div class="m-btn-row"><button class="m-btn m-btn-primary m-btn-block" onclick="M._saveSettings()">保存设置</button></div>';
    },
    async _saveSettings() {
      var current = await API.getSettings() || {};
      var settings = Object.assign({}, current, { systemName: document.getElementById('m-setting-name').value.trim(), theme: document.getElementById('m-setting-theme').value, enableNotifications: document.getElementById('m-setting-notify').checked, enableSSE: document.getElementById('m-setting-sse').checked });
      try { await API.saveSettings(settings); document.documentElement.setAttribute('data-theme', settings.theme === 'dark' ? 'dark' : 'light'); this.closeModal(); this.hideSubPageView(); this.toast('设置已保存', 'ok'); } catch (e) { this.toast('设置保存失败', 'err'); }
    },
    async _renderPopupMessages(wrap) {
      var user = this.currentUser || {};
      if (user.role !== 'admin' && user.role !== 'superadmin') { wrap.innerHTML='<div class="m-empty"><div class="m-empty-text">无权限访问</div></div>'; return; }
      var submitMsgs = [], completeMsgs = [];
      try { submitMsgs = await API.getPopupMessages('submit'); completeMsgs = await API.getPopupMessages('complete'); } catch(e){}
      var renderList = function(msgs, cat) {
        if (!msgs || !msgs.length) return '';
        return msgs.map(function(m){ return '<div class="m-data-row"><div class="m-card-row"><div class="m-data-value">'+M._esc(m.text)+'</div><button class="m-btn m-btn-outline" style="flex:0 0 auto;padding:6px 10px;min-height:0;" onclick="M._deletePopupMessage(\''+M._esc(m.id)+'\',\''+cat+'\')">删除</button></div></div>'; }).join('');
      };
      wrap.innerHTML =
        '<div class="m-form-section"><div class="m-section-title">提交后弹窗句子 ('+submitMsgs.length+'条)</div>'+
          (renderList(submitMsgs,'submit')||'<div class="m-empty" style="padding:16px;"><div class="m-empty-text">暂无句子</div></div>')+
          '<div class="m-field" style="margin-top:10px;"><input id="m-pm-submit" class="m-input" placeholder="输入新的提交后鼓励语..."></div>'+
          '<button class="m-btn m-btn-primary m-btn-block" onclick="M._addPopupMessage(\'submit\')">添加</button>'+
        '</div>'+
        '<div class="m-form-section"><div class="m-section-title">维修完成弹窗句子 ('+completeMsgs.length+'条)</div>'+
          (renderList(completeMsgs,'complete')||'<div class="m-empty" style="padding:16px;"><div class="m-empty-text">暂无句子</div></div>')+
          '<div class="m-field" style="margin-top:10px;"><input id="m-pm-complete" class="m-input" placeholder="输入新的维修完成鼓励语..."></div>'+
          '<button class="m-btn m-btn-primary m-btn-block" onclick="M._addPopupMessage(\'complete\')">添加</button>'+
        '</div>';
    },
    async _addPopupMessage(category) {
      var input = document.getElementById(category==='submit'?'m-pm-submit':'m-pm-complete');
      var text = (input && input.value || '').trim();
      if (!text) { this.toast('请输入句子内容','err'); return; }
      var result = await API.addPopupMessage(category, text);
      if (result && result.success) { this.toast('句子已添加','ok'); this.showAdminSubPage('popup'); }
      else this.toast((result&&(result.error||result.message))||'添加失败','err');
    },
    async _deletePopupMessage(id, category) {
      var result = await API.deletePopupMessage(id);
      if (result && result.success) { this.toast('句子已删除','ok'); this.showAdminSubPage('popup'); }
      else this.toast((result&&(result.error||result.message))||'删除失败','err');
    },

    async _renderSOP(wrap) {
      var user = this.currentUser || {};
      if (user.role !== 'admin' && user.role !== 'superadmin') { wrap.innerHTML='<div class="m-empty"><div class="m-empty-text">无权限访问</div></div>'; return; }
      var docs = [];
      try { docs = await API.getSOP(); API._sopCache = docs; } catch(e){}
      var cats = [...new Set(docs.map(function(d){return d.category||'默认';}))].sort();
      var html = '<div class="m-form-section">';
      html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">';
      html += '<input id="m-sop-search" class="m-input" placeholder="搜索..." style="flex:1;min-width:0;">';
      html += '<select id="m-sop-cat" class="m-input" style="width:auto;flex:0 0 auto;max-width:120px;"><option value="all">全部分类</option>';
      cats.forEach(function(c){ html += '<option value="'+M._esc(c)+'">'+M._esc(c)+'</option>'; });
      html += '</select></div>';

      html += '<div style="margin-bottom:12px;padding:10px;background:var(--bg2);border-radius:8px;">';
      html += '<div style="font-weight:600;font-size:0.8rem;margin-bottom:8px;">添加 SOP</div>';
      html += '<input id="m-sop-title" class="m-input" placeholder="标题 *" style="margin-bottom:6px;">';
      html += '<input id="m-sop-category" class="m-input" placeholder="分类（默认）" style="margin-bottom:6px;">';
      html += '<select id="m-sop-kind" class="m-input" onchange="M._toggleMobileSOPKind()" style="margin-bottom:6px;">';
      html += '<option value="url">🔗 链接（飞书文档）</option>';
      html += '<option value="text">📄 粘贴内容</option>';
      html += '<option value="file">📎 上传文件</option></select>';
      html += '<input id="m-sop-url" class="m-input" placeholder="飞书链接" style="margin-bottom:6px;">';
      html += '<textarea id="m-sop-text" class="m-input" placeholder="在此粘贴 SOP 内容..." style="min-height:80px;resize:vertical;display:none;margin-bottom:6px;"></textarea>';
      html += '<input type="file" id="m-sop-file" accept=".pdf,.png,.jpg,.jpeg,.gif,.webp" style="display:none;margin-bottom:6px;font-size:0.8rem;">';
      html += '<button class="m-btn m-btn-primary m-btn-block" onclick="M._addSOP()">添加</button>';
      html += '</div>';

      html += '<div id="m-sop-list">';
      html += M._renderMobileSOPList(docs);
      html += '</div></div>';
      wrap.innerHTML = html;
      M._toggleMobileSOPKind();
      var searchInput = document.getElementById('m-sop-search');
      if (searchInput) searchInput.addEventListener('input', function(){ M._filterMobileSOP(); });
      var catSelect = document.getElementById('m-sop-cat');
      if (catSelect) catSelect.addEventListener('change', function(){ M._filterMobileSOP(); });
    },
    _toggleMobileSOPKind() {
      var kind = document.getElementById('m-sop-kind')?.value || 'url';
      var urlGroup = document.getElementById('m-sop-url');
      var textGroup = document.getElementById('m-sop-text');
      var fileGroup = document.getElementById('m-sop-file');
      if (urlGroup) urlGroup.style.display = kind === 'url' ? '' : 'none';
      if (textGroup) textGroup.style.display = kind === 'text' ? '' : 'none';
      if (fileGroup) fileGroup.style.display = kind === 'file' ? '' : 'none';
    },
    _renderMobileSOPList(docs) {
      if (!docs.length) return '<div class="m-empty"><div class="m-empty-text">暂无 SOP</div></div>';
      var html = '';
      docs.forEach(function(d){
        var colors = ['#6366f1','#10b981','#f59e0b','#ef4444','#3b82f6','#8b5cf6','#14b8a6'];
        var h = 0; for(var i=0;i<(d.category||'').length;i++) h=(h*31+(d.category||'').charCodeAt(i))%997;
        var c = colors[h%colors.length];
        var kind = d.kind || 'url';
        var onclick;
        if (kind === 'url') onclick = 'window.open(\''+M._esc(d.url)+'\',\'_blank\')';
        else if (kind === 'file') onclick = 'M._viewMobileSOPFile(\''+M._esc(d.content)+'\',\''+M._esc(d.mime||'')+'\',\''+M._esc(d.title)+'\')';
        else onclick = 'M._viewMobileSOPText(\''+M._esc(d.id)+'\')';
        var typeTag = '';
        if (kind === 'url') typeTag = '<span style="font-size:0.65rem;color:#6366f1;">🔗</span>';
        else if (kind === 'text') typeTag = '<span style="font-size:0.65rem;color:#10b981;">📄</span>';
        else if (kind === 'file') typeTag = '<span style="font-size:0.65rem;color:#f59e0b;">📎</span>';
        html += '<div class="m-data-row" style="cursor:pointer;" onclick="'+onclick+'">';
        html += '<div class="m-card-row"><div><span style="display:inline-block;background:'+c+';color:#fff;padding:2px 6px;border-radius:4px;font-size:0.65rem;">'+M._esc(d.category||'默认')+'</span> '+typeTag+'</div>';
        html += '<div style="font-weight:600;font-size:0.85rem;margin:4px 0;">'+M._esc(d.title)+'</div>';
        html += '<div style="font-size:0.7rem;color:var(--muted);">'+M._esc(d.uploaded_at||'')+'</div></div>';
        html += '<button class="m-btn m-btn-outline" style="flex:0 0 auto;padding:4px 8px;min-height:0;color:#ef4444;border-color:#ef4444;" onclick="event.stopPropagation();M._deleteSOP(\''+M._esc(d.id)+'\')">删除</button>';
        html += '</div>';
      });
      return html;
    },
    _viewMobileSOPText(id) {
      var docs = API._sopCache || [];
      var doc = null;
      for (var i=0;i<docs.length;i++) { if (String(docs[i].id)===String(id)) { doc=docs[i]; break; } }
      if (!doc || !doc.content) return;
      M.openModal(doc.title, '<div style="max-height:70vh;overflow-y:auto;white-space:pre-wrap;font-size:0.85rem;line-height:1.6;padding:8px;">'+M._esc(doc.content)+'</div>', []);
    },
    _viewMobileSOPFile(fileName, mime, title) {
      var url = '/api/sop/serve/'+fileName;
      var content;
      if (mime && mime.indexOf('image/')===0) {
        content = '<img src="'+url+'" style="max-width:100%;" alt="'+M._esc(title)+'">';
      } else {
        content = '<iframe src="'+url+'" style="width:100%;height:70vh;border:none;" allowfullscreen></iframe>';
      }
      M.openModal(title, '<div style="text-align:center;">'+content+'</div>', []);
    },
    _filterMobileSOP() {
      var q = (document.getElementById('m-sop-search')?.value || '').toLowerCase();
      var cat = document.getElementById('m-sop-cat')?.value || 'all';
      API.getSOP().then(function(docs){
        docs = docs.filter(function(d){ return (cat==='all'||(d.category||'默认')===cat) && (!q||(d.title||'').toLowerCase().includes(q)||(d.category||'').toLowerCase().includes(q)); });
        var list = document.getElementById('m-sop-list');
        if (!list) return;
        list.innerHTML = M._renderMobileSOPList(docs);
      }).catch(function(){});
    },

    async _renderSolutions(wrap) {
      var user = this.currentUser || {};
      if (!user) { wrap.innerHTML = '<div class="m-empty"><div class="m-empty-text">请先登录</div></div>'; return; }
      var isAdmin = user.role === 'admin' || user.role === 'superadmin';
      var sols = [];
      try { sols = await API.getSolutions(); } catch(e) {}
      var cats = [...new Set(sols.map(function(s){return s.category||'默认';}))].sort();
      var html = '<div class="m-form-section">';
      html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">';
      html += '<input id="m-sol-search" class="m-input" placeholder="搜索..." style="flex:1;min-width:0;">';
      html += '<select id="m-sol-cat" class="m-input" style="width:auto;flex:0 0 auto;max-width:120px;"><option value="all">全部分类</option>';
      cats.forEach(function(c){ html += '<option value="'+M._esc(c)+'">'+M._esc(c)+'</option>'; });
      html += '</select></div>';

      if (isAdmin) {
        html += '<div style="margin-bottom:12px;padding:10px;background:var(--bg2);border-radius:8px;">';
        html += '<div style="font-weight:600;font-size:0.8rem;margin-bottom:8px;">新建解决方案</div>';
        html += '<input id="m-sol-title" class="m-input" placeholder="标题 *" style="margin-bottom:6px;">';
        html += '<input id="m-sol-desc" class="m-input" placeholder="简介" style="margin-bottom:6px;">';
        html += '<input id="m-sol-cat-input" class="m-input" placeholder="分类（默认）" style="margin-bottom:6px;">';
        html += '<input id="m-sol-tags" class="m-input" placeholder="标签（逗号分隔）" style="margin-bottom:6px;">';
        html += '<textarea id="m-sol-steps" class="m-input" placeholder="实施步骤..." style="min-height:60px;resize:vertical;margin-bottom:6px;"></textarea>';
        html += '<textarea id="m-sol-res" class="m-input" placeholder="所需资源" style="min-height:40px;resize:vertical;margin-bottom:6px;"></textarea>';
        html += '<textarea id="m-sol-scen" class="m-input" placeholder="适用场景" style="min-height:40px;resize:vertical;margin-bottom:6px;"></textarea>';
        html += '<textarea id="m-sol-veri" class="m-input" placeholder="验证方法" style="min-height:40px;resize:vertical;margin-bottom:6px;"></textarea>';
        html += '<button class="m-btn m-btn-primary m-btn-block" onclick="M._addMobileSolution()">创建</button>';
        html += '</div>';
      }

      html += '<div id="m-sol-list">';
      html += M._renderMobileSolList(sols, isAdmin);
      html += '</div></div>';
      wrap.innerHTML = html;
      var searchInput = document.getElementById('m-sol-search');
      if (searchInput) searchInput.addEventListener('input', function(){ M._filterMobileSols(); });
      var catSelect = document.getElementById('m-sol-cat');
      if (catSelect) catSelect.addEventListener('change', function(){ M._filterMobileSols(); });
    },
    _renderMobileSolList(sols, isAdmin) {
      if (!sols.length) return '<div class="m-empty"><div class="m-empty-text">暂无解决方案</div></div>';
      var html = '';
      sols.forEach(function(s){
        var colors = ['#6366f1','#10b981','#f59e0b','#ef4444','#3b82f6','#8b5cf6','#14b8a6'];
        var h = 0; for(var i=0;i<(s.category||'').length;i++) h=(h*31+(s.category||'').charCodeAt(i))%997;
        var c = colors[h%colors.length];
        html += '<div class="m-data-row" style="cursor:pointer;" onclick="M._viewMobileSolution(\''+M._esc(s.id)+'\')">';
        html += '<div class="m-card-row"><div><span style="display:inline-block;background:'+c+';color:#fff;padding:2px 6px;border-radius:4px;font-size:0.65rem;">'+M._esc(s.category||'默认')+'</span> <span style="font-size:0.65rem;color:var(--muted);">⬆'+(s.usage_count||0)+'次</span></div>';
        html += '<div style="font-weight:600;font-size:0.85rem;margin:4px 0;">'+M._esc(s.title)+'</div>';
        if (s.description) html += '<div style="font-size:0.7rem;color:var(--muted);">'+M._esc(s.description)+'</div>';
        if (s.tags) html += '<div style="font-size:0.65rem;color:#6366f1;margin-top:2px;">'+M._esc(s.tags)+'</div>';
        html += '</div>';
        if (isAdmin) {
          html += '<button class="m-btn m-btn-outline" style="flex:0 0 auto;padding:4px 8px;min-height:0;color:#ef4444;border-color:#ef4444;" onclick="event.stopPropagation();M._deleteMobileSolution(\''+M._esc(s.id)+'\')">删除</button>';
        }
        html += '</div>';
      });
      return html;
    },
    async _viewMobileSolution(id) {
      var sols = [];
      try { sols = await API.getSolutions(); } catch(e) {}
      var s = null;
      for (var i=0;i<sols.length;i++) { if (String(sols[i].id)===String(id)) { s=sols[i]; break; } }
      if (!s) { try { s = await API.getSolution(id); } catch(e) {} }
      if (!s) { this.toast('解决方案不存在','err'); return; }
      var sec = function(title, val) {
        return '<div style="margin-bottom:10px;"><div style="font-weight:600;font-size:0.8rem;margin-bottom:4px;">'+title+'</div><div style="font-size:0.8rem;line-height:1.6;background:var(--bg2);padding:8px;border-radius:6px;white-space:pre-wrap;">'+(val?M._esc(val):'<span style="color:var(--muted);">暂无</span>')+'</div></div>';
      };
      var html = '<div style="max-height:70vh;overflow-y:auto;padding:4px;">';
      html += '<div style="margin-bottom:10px;"><span style="display:inline-block;background:'+(s.category?'#6366f1':'#888')+';color:#fff;padding:2px 8px;border-radius:4px;font-size:0.7rem;">'+M._esc(s.category||'默认')+'</span> <span style="font-size:0.7rem;color:var(--muted);">⬆ '+(s.usage_count||0)+' 次</span></div>';
      html += '<h3 style="margin:0 0 8px;font-size:0.95rem;">'+M._esc(s.title)+'</h3>';
      if (s.description) html += '<div style="font-size:0.8rem;color:var(--muted);margin-bottom:10px;">'+M._esc(s.description)+'</div>';
      html += sec('实施步骤', s.steps);
      html += sec('所需资源', s.resources);
      html += sec('适用场景', s.scenarios);
      html += sec('验证方法', s.verification);
      html += '<div style="font-size:0.65rem;color:var(--muted);border-top:1px solid var(--border-color);padding-top:8px;">创建者：'+M._esc(s.created_by||'-')+'　'+((s.created_at||'').replace('T',' ').slice(0,16))+'</div>';
      html += '</div>';
      M.openModal(s.title, html, []);
    },
    async _addMobileSolution() {
      var title = (document.getElementById('m-sol-title')?.value||'').trim();
      if (!title) { this.toast('标题不能为空','err'); return; }
      var payload = {
        title: title,
        description: (document.getElementById('m-sol-desc')?.value||'').trim(),
        category: (document.getElementById('m-sol-cat-input')?.value||'').trim()||'默认',
        tags: (document.getElementById('m-sol-tags')?.value||'').trim(),
        steps: (document.getElementById('m-sol-steps')?.value||'').trim(),
        resources: (document.getElementById('m-sol-res')?.value||'').trim(),
        scenarios: (document.getElementById('m-sol-scen')?.value||'').trim(),
        verification: (document.getElementById('m-sol-veri')?.value||'').trim(),
      };
      var r = await API.createSolution(payload);
      if (r && r.success !== false) { this.toast('创建成功'); this.showAdminSubPage('solutions'); }
      else this.toast(r?.error||'创建失败','err');
    },
    async _deleteMobileSolution(id) {
      var go = await this._askConfirm('确认删除该解决方案？删除后不可恢复。', '删除方案');
      if (!go) return;
      var r = await API.deleteSolution(id);
      if (r && r.success !== false) { this.toast('已删除'); this.showAdminSubPage('solutions'); }
      else this.toast(r?.error||'删除失败','err');
    },

    async _renderReplacement(wrap) {
      if (!wrap) return;
      var self = this;
      this._rplSel = this._rplSel || {};
      var html = '<div class="m-subpage-title">置换库存</div>';
      html += '<div style="margin-bottom:12px;display:flex;gap:8px;align-items:center;">';
      html += '<input id="m-rpl-input" type="text" placeholder="输入 SN 码加入置换库存" style="flex:1;padding:8px;border:1px solid var(--border-color);border-radius:6px;font-size:0.8rem;">';
      html += '<button class="m-btn m-btn-primary" onclick="M._addReplacement()" style="flex-shrink:0;">加入置换</button>';
      html += '<button class="m-btn m-btn-outline" id="m-rpl-batch-btn" onclick="M._toggleReplacementBatch()" style="flex-shrink:0;font-size:0.75rem;padding:8px 10px;">批量</button>';
      html += '</div>';
      html += '<div id="m-rpl-list"><div class="m-loading">加载中...</div></div>';
      wrap.innerHTML = html;
      await this._refreshReplacementList();
    },
    async _refreshReplacementList() {
      var list = document.getElementById('m-rpl-list');
      if (!list) return;
      list.innerHTML = '<div class="m-loading">加载中...</div>';
      try {
        var rows = await API.getReplacements();
        if (!rows || rows.length === 0) {
          list.innerHTML = '<div class="m-empty"><div class="m-empty-text">暂无置换记录</div></div>';
          return;
        }
        var statusLabels = {
          'in_replacement': { text: '置换中', cls: 'status-warn' },
          'returned': { text: '已退回库存', cls: 'status-ok' },
          'sent_to_manufacturer': { text: '已发厂家', cls: 'status-dim' },
        };
        var h = '';
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          var sl = statusLabels[r.status] || { text: r.status, cls: '' };
          var isActive = r.status === 'in_replacement';
          var actions = '';
          if (isActive) {
            if (this._rplBatch) {
              var chkId = 'rpl-chk-' + i;
              var isChk = this._rplSel && this._rplSel[r.snCode] ? 'checked' : '';
              actions = '<div style="display:flex;align-items:center;gap:8px;margin-top:6px;">' +
                '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:0.78rem;">' +
                '<input type="checkbox" id="'+chkId+'" class="rpl-chk" value="'+this._esc(r.snCode)+'" '+isChk+' onchange="M._rplToggleItem(this.value, this.checked)" style="width:18px;height:18px;accent-color:var(--danger);">' +
                '选择发货</label></div>';
            } else {
              actions = '<div style="display:flex;gap:6px;margin-top:6px;">' +
                '<button class="m-btn m-btn-sm" onclick="M._returnReplacement(\''+this._esc(r.snCode)+'\')" style="background:var(--success);color:#fff;">退回库存</button>' +
                '<button class="m-btn m-btn-sm" onclick="M._shipReplacement(\''+this._esc(r.snCode)+'\')" style="background:var(--danger);color:#fff;">发货厂家</button>' +
                '</div>';
            }
          }
          h += '<div class="m-card" style="margin-bottom:8px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<span style="font-weight:600;font-size:0.85rem;">'+this._esc(r.snCode)+'</span>' +
            '<span class="'+sl.cls+'" style="font-size:0.7rem;padding:2px 6px;border-radius:4px;">'+sl.text+'</span>' +
            '</div>' +
            '<div style="font-size:0.75rem;color:var(--muted);margin-top:4px;">' +
            '类型: ' + (r.equipmentType === 'robot_paw' ? '灵巧手' : 'wuji手套') +
            ' | 手别: ' + (r.handType === 'right' ? '右手' : '左手') +
            ' | 操作人: ' + this._esc(r.operator || '-') +
            '</div>' +
            (r.note ? '<div style="font-size:0.7rem;color:var(--muted);margin-top:2px;">备注: ' + this._esc(r.note) + '</div>' : '') +
            '<div style="font-size:0.65rem;color:var(--muted);margin-top:2px;">' + ((r.createdAt||'').replace('T',' ').slice(0,16)) + '</div>' +
            actions +
            '</div>';
        }

        if (this._rplBatch) {
          h += '<div style="position:sticky;bottom:10px;background:var(--bg-card);padding:10px 12px;border-radius:10px;box-shadow:0 -2px 10px rgba(0,0,0,.08);display:flex;gap:8px;margin-top:10px;">' +
            '<button class="m-btn m-btn-sm m-btn-outline" onclick="M._rplSelectAll()" style="flex:1;">全选/取消</button>' +
            '<button class="m-btn m-btn-sm" onclick="M._batchShipReplacement()" style="background:var(--danger);color:#fff;flex:1.2;">批量发货</button>' +
            '</div>';
        }
        list.innerHTML = h;
      } catch(e) {
        list.innerHTML = '<div class="m-empty"><div class="m-empty-text">加载失败: ' + this._esc(e.message) + '</div></div>';
      }
    },
    async _addReplacement() {
      var input = document.getElementById('m-rpl-input');
      var code = (input && input.value || '').trim().toUpperCase();
      if (!code) { this.toast('请输入 SN 码','err'); return; }
      var r = await API.addReplacement(code, '');
      if (r && r.success !== false) {
        this.toast('已加入置换库存');
        if (input) input.value = '';
        this._refreshReplacementList();
      } else {
        this.toast(r?.error || '操作失败','err');
      }
    },
    async _returnReplacement(snCode) {
      var go = await this._askConfirm('确认将 <b>'+this._esc(snCode)+'</b> 退回库存？', '退回库存');
      if (!go) return;
      var r = await API.returnReplacement(snCode, '');
      if (r && r.success !== false) { this.toast('已退回库存'); this._refreshReplacementList(); }
      else { this.toast(r?.error || '操作失败','err'); }
    },
    async _shipReplacement(snCode) {
      var tracking = await this._askText('可选，发货后该 SN 将报废', '请输入运单号', '运单号（可选）');
      if (tracking === null) return;
      var go = await this._askConfirm('确认将 <b>'+this._esc(snCode)+'</b> 发货厂家？此操作后该 SN 将报废不可再用！', '发货确认');
      if (!go) return;
      var r = await API.shipReplacement(snCode, tracking || '', '');
      if (r && r.success !== false) {
        this.toast('已发货厂家');

        var rows = await API.getReplacements();
        var row = (rows||[]).find(function(x) { return x.snCode === snCode; });
        var items = [{ snCode: snCode, eqLabel: row && row.equipmentType === 'robot_paw' ? '灵巧手' : 'wuji手套', handLabel: row && row.handType === 'right' ? '右手' : '左手', equipmentType: row ? row.equipmentType : 'glove', handType: row ? row.handType : 'left', reason: '' }];
        var dn = await API.saveDeliveryNote({ type: 'replacement', items: items, trackingNumber: tracking || '' });
        if (dn && dn.success) {
          var dop = await this._askConfirm('发货单已保存，是否立即打印？', '打印发货单');
          if (dop) {
            M._printDeliveryNote(dn.id);
          }
        }
        this._refreshReplacementList();
      } else { this.toast(r?.error || '操作失败','err'); }
    },

    async _toggleReplacementBatch() {
      this._rplBatch = !this._rplBatch;
      if (!this._rplBatch) this._rplSel = {};
      var btn = document.getElementById('m-rpl-batch-btn');
      if (btn) {
        btn.textContent = this._rplBatch ? '取消' : '批量';
        btn.style.background = this._rplBatch ? 'var(--danger)' : '';
        btn.style.color = this._rplBatch ? '#fff' : '';
      }
      await this._refreshReplacementList();
    },
    _rplToggleItem(sn, checked) {
      this._rplSel = this._rplSel || {};
      if (checked) this._rplSel[sn] = true;
      else delete this._rplSel[sn];
    },
    _rplSelectAll() {
      var boxes = document.getElementsByClassName('rpl-chk');
      var allChecked = true;
      for (var i = 0; i < boxes.length; i++) { if (!boxes[i].checked) allChecked = false; }
      var want = !allChecked;
      for (i = 0; i < boxes.length; i++) {
        boxes[i].checked = want;
        M._rplToggleItem(boxes[i].value, want);
      }
    },
    async _batchShipReplacement() {
      var sels = Object.keys(this._rplSel || {});
      if (!sels.length) { this.toast('请先选择要发货的 SN', 'err'); return; }
      var tracking = await this._askText('多个 SN 可共用同一单号', '请输入运单号', '运单号（可选）');
      if (tracking === null) return;
      var go = await this._askConfirm('确认将 <b>'+sels.length+'</b> 个 SN 发货厂家？此操作后这些 SN 将报废不可再用！', '批量发货确认');
      if (!go) return;
      var ok = 0, fail = 0, firstErr = '';
      for (var i = 0; i < sels.length; i++) {
        var r = await API.shipReplacement(sels[i], tracking || '', '');
        if (r && r.success !== false) ok++;
        else { fail++; if (!firstErr) firstErr = r?.error || '操作失败'; }
      }
      if (ok > 0) {
        this.toast('已发货 ' + ok + ' 个 SN');

        var rows = await API.getReplacements();
        var items = [];
        sels.forEach(function(sn) {
          var row = rows.find(function(x) { return x.snCode === sn; });
          items.push({
            snCode: sn,
            eqLabel: row && row.equipmentType === 'robot_paw' ? '灵巧手' : 'wuji手套',
            handLabel: row && row.handType === 'right' ? '右手' : '左手',
            equipmentType: row ? row.equipmentType : 'glove',
            handType: row ? row.handType : 'left',
            reason: ''
          });
        });
        var dn = await API.saveDeliveryNote({ type: 'replacement', items: items, trackingNumber: tracking || '' });
        if (dn && dn.success) {
          var dop = await this._askConfirm('发货单已保存，是否立即打印？', '打印发货单');
          if (dop) {
            M._printDeliveryNote(dn.id);
          }
        }
      }
      if (fail > 0) this.toast(fail + ' 个失败' + (firstErr ? '：' + firstErr : ''), 'err');
      this._rplBatch = false; this._rplSel = {};
      await this._refreshReplacementList();
    },

    async _renderStorageLocations(wrap) {
      var self = this;
      var list = await API.getStorageLocations() || [];
      if (!list.length) {
        wrap.innerHTML = '<div class="m-subpage-title">库位管理</div><div class="m-empty"><div class="m-empty-text">暂无库位</div></div><div class="m-btn-row"><button class="m-btn m-btn-primary" onclick="M._showAddLocationModal()">+ 添加库位</button></div>';
        return;
      }
      var isAdmin = this.currentUser && (this.currentUser.role === 'admin' || this.currentUser.role === 'superadmin');
      var addBtn = isAdmin ? '<button class="m-btn m-btn-sm m-btn-primary" onclick="M._showAddLocationModal()" style="display:inline-flex;align-items:center;gap:4px;font-size:0.8rem;padding:6px 12px;">+ 添加</button>' : '';
      var html = '<div class="m-subpage-title" style="display:flex;justify-content:space-between;align-items:center;">库位管理<span>'+addBtn+'</span></div>';
      var total = list.reduce(function(s, l) { return s + (Number(l.snCount)||0); }, 0);
      html += '<div style="display:flex;gap:8px;padding:4px 16px 12px;font-size:0.78rem;color:var(--muted);"><span>共 '+list.length+' 个库位</span><span>已关联 '+total+' 台设备</span></div>';
      html += '<div class="m-card-list">';
      list.forEach(function(l) {
        html += '<div class="m-card" style="margin-bottom:10px;cursor:pointer;" onclick="M._renderLocationDetail(\''+self._esc(l.code)+'\')">'+
          '<div style="display:flex;align-items:center;gap:10px;">'+
            '<div style="width:36px;height:36px;border-radius:10px;background:#dbeafe;color:#2563eb;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-weight:700;font-size:0.8rem;">📦</div>'+
            '<div style="flex:1;min-width:0;">'+
              '<div style="font-family:monospace;font-weight:700;font-size:0.9rem;">'+self._esc(l.code)+'</div>'+
              (l.name ? '<div style="font-size:0.75rem;color:var(--muted);">'+self._esc(l.name)+'</div>' : '')+
            '</div>'+
            '<span class="m-badge'+(Number(l.snCount)>0?' m-badge-ok':'')+'">'+ (Number(l.snCount)||0) +' 台</span>'+
          '</div>'+
          (l.area ? '<div style="font-size:0.7rem;color:var(--text3);margin-top:6px;"><span style="background:#f1f5f9;padding:2px 10px;border-radius:10px;">'+self._esc(l.area)+'</span></div>' : '')+
        '</div>';
      });
      html += '</div>';
      wrap.innerHTML = html;
    },

    _renderLocationDetail: async function(code) {
      var self = this;
      this.showSubPage('库位: '+code, async function(content) {
        try {
          var locs = Storage.getStorageLocations() || [];
          var loc = locs.find(function(l) { return l.code === code; }) || { code: code, name: '', area: '', description: '' };
          var sns = await API.getLocationSNs(code) || [];
          var stLabel = { available: '可用', in_use: '使用中', damaged: '损坏', in_repair: '维修中' };
          var locUrl = window.location.origin+'/location-status.html?code='+encodeURIComponent(code);
          var html = '<div style="padding:12px 0;">'+
            (loc.area ? '<div style="font-size:0.8rem;color:var(--muted);margin-bottom:4px;">区域: '+self._esc(loc.area)+'</div>' : '')+
            (loc.description ? '<div style="font-size:0.78rem;color:var(--text3);margin-bottom:10px;">'+self._esc(loc.description)+'</div>' : '')+
            '<div style="margin-bottom:10px;padding:8px;background:#f8fafc;border-radius:8px;font-size:0.65rem;color:var(--text3);word-break:break-all;">'+self._esc(locUrl)+'</div>'+
            '<div style="display:flex;gap:6px;margin-bottom:12px;">'+
              '<a href="'+locUrl+'" target="_blank" class="m-btn m-btn-sm m-btn-outline" style="font-size:0.75rem;text-decoration:none;display:inline-flex;align-items:center;gap:4px;">打开链接</a>'+
              '<button class="m-btn m-btn-sm m-btn-outline" onclick="M._copyLocationLink(\''+self._esc(code)+'\')" style="font-size:0.75rem;">复制链接</button>'+
            '</div>'+
            '<div style="font-size:0.85rem;font-weight:600;margin-bottom:10px;">设备 ('+sns.length+' 台)</div>';
          if (!sns.length) {
            html += '<div class="m-empty"><div class="m-empty-text">该库位暂无设备</div></div>';
          } else {
            sns.forEach(function(s) {
              html += '<div class="m-device-card" style="margin-bottom:8px;">'+
                '<div class="m-device-header"><div class="m-device-name">'+self._esc(s.snCode)+'</div><span class="m-badge '+(s.status==='available'?'m-badge-ok':s.status==='in_use'?'':'m-badge-err')+'">'+(stLabel[s.status]||self._esc(s.status))+'</span></div>'+
                '<div class="m-device-info">'+self._esc(s.equipmentType||'-')+(s.handType?' · '+(s.handType==='left'?'左手':'右手'):'')+(s.source?' · 来源:'+self._esc(s.source):'')+'</div>'+
                (s.machineNumber?'<div class="m-device-info">绑定: '+self._esc(s.machineNumber)+'</div>':'')+
              '</div>';
            });
          }
          content.innerHTML = '<div class="m-subpage-title">库位: '+self._esc(code)+'</div>'+html;
        } catch (e) {
          console.error('[LocationDetail]', e);
          content.innerHTML = '<div class="m-subpage-title">库位: '+self._esc(code)+'</div><div class="m-empty"><div class="m-empty-text">加载失败，请下拉刷新重试</div></div>';
        }
      });
    },

    _copyLocationLink: function(code) {
      var url = window.location.origin+'/location-status.html?code='+encodeURIComponent(code);
      try {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(url).then(function() {
            M.toast('链接已复制');
          }).catch(function() {
            M._fallbackCopy(url);
          });
        } else {
          M._fallbackCopy(url);
        }
      } catch(e) { M._fallbackCopy(url); }
    },

    _fallbackCopy: function(text) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); M.toast('链接已复制'); } catch { M.toast('复制失败', 'err'); }
      document.body.removeChild(ta);
    },

    _showAddLocationModal: function() {
      var self = this;
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">添加库位</div><button class="m-modal-close" onclick="M.closeModal()">x</button></div>'+
        '<div class="m-form-section"><div class="m-field"><label class="m-field-label">库位编码 *</label><input id="m-loc-code" class="m-input" placeholder="如 A-01, B-02" style="font-family:monospace;"></div>'+
        '<div class="m-field"><label class="m-field-label">库位名称</label><input id="m-loc-name" class="m-input" placeholder="如 手套A货架"></div>'+
        '<div class="m-field"><label class="m-field-label">区域</label><input id="m-loc-area" class="m-input" placeholder="如 A区, B区"></div>'+
        '<div class="m-field"><label class="m-field-label">描述</label><textarea id="m-loc-desc" class="m-input" style="min-height:60px;resize:vertical;" placeholder="库位说明（可选）"></textarea></div>'+
        '<div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">取消</button><button class="m-btn m-btn-primary" onclick="M._submitAddLocation()">保存</button></div></div>');
    },
    _submitAddLocation: async function() {
      var code = (document.getElementById('m-loc-code')?.value||'').trim();
      var name = (document.getElementById('m-loc-name')?.value||'').trim();
      var area = (document.getElementById('m-loc-area')?.value||'').trim();
      var desc = (document.getElementById('m-loc-desc')?.value||'').trim();
      if (!code) { this.toast('库位编码不能为空', 'err'); return; }
      var r = await API.addStorageLocation({ code: code, name: name, area: area, description: desc });
      if (r && r.success !== false) {
        this.closeModal();
        this.toast('库位已添加', 'ok');
        this.showAdminSubPage('storage-locations');
      } else {
        this.toast((r && (r.error||r.message)) || '添加失败', 'err');
      }
    },

    async _renderInventoryConfig(wrap) {
      var user = this.currentUser || {};
      if (user.role !== 'admin' && user.role !== 'superadmin') { wrap.innerHTML='<div class="m-empty"><div class="m-empty-text">无权限访问</div></div>'; return; }
      var html = '<div class="m-subpage-title">库存配置</div>';
      html += '<div style="display:flex;gap:8px;padding:0 16px 12px;align-items:center;">';
      html += '<button class="m-btn m-btn-primary" style="flex:1;margin:0;" onclick="M._invcfgShowForm(\'\')">＋ 添加库存类型</button>';
      html += '<button class="m-btn m-btn-outline" style="margin:0;" onclick="M._invcfgImport()">导入</button>';
      html += '<button class="m-btn m-btn-outline" style="margin:0;" onclick="M._invcfgExport()">导出</button>';
      html += '</div>';
      html += '<div id="m-invcfg-list"><div class="m-loading">加载中...</div></div>';
      wrap.innerHTML = html;
      await this._refreshInventoryConfigList();
    },
    async _refreshInventoryConfigList() {
      var list = document.getElementById('m-invcfg-list');
      if (!list) return;
      list.innerHTML = '<div class="m-loading">加载中...</div>';
      try {
        var rows = (await API.getInventoryConfig()) || [];
        if (!rows.length) {
          list.innerHTML = '<div class="m-empty"><div class="m-empty-text">暂无库存类型，点击上方按钮添加</div></div>';
          return;
        }
        var h = '';
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          var invLabel = r.sku || r.id || '';
          var lrTag = r.hasLeftRight ? '<span class="m-badge m-badge-info" style="margin-left:4px;">左右手</span>' : '';
          var isQty = r.trackingMode === 'quantity';
          var modeTag = '<span class="m-badge ' + (isQty ? 'm-badge-wrn' : 'm-badge-ok') + '" style="margin-left:4px;">' + (isQty ? '纯数量' : 'SN精细') + '</span>';
          h += '<div class="m-card" style="margin:0 16px 8px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<div style="display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden;">' +
            '<span style="font-size:1.1rem;flex-shrink:0;">' + M._esc(r.icon || '📦') + '</span>' +
            '<span style="font-weight:600;font-size:0.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + M._esc(r.name) + '</span>' + lrTag + modeTag +
            '</div>' +
            '<div style="display:flex;gap:6px;flex-shrink:0;">' +
            '<button class="m-btn m-btn-sm" onclick="M._invcfgShowForm(\'' + M._esc(r.id) + '\')">编辑</button>' +
            '<button class="m-btn m-btn-sm" style="background:var(--danger,#ef4444);color:#fff;" onclick="M._invcfgDelete(\'' + M._esc(r.id) + '\')">删除</button>' +
            '</div></div>' +
            '<div style="font-size:0.72rem;color:var(--muted);margin-top:4px;">SKU: ' + M._esc(invLabel) + '</div>' +
            '</div>';
        }
        list.innerHTML = h;
      } catch(e) {
        list.innerHTML = '<div class="m-empty"><div class="m-empty-text">加载失败: ' + M._esc(e.message) + '</div></div>';
      }
    },
    _invcfgShowForm(id) {
      var self = this;
      if (id) {
        API.getInventoryConfig().then(function(list){
          var item = (list||[]).filter(function(x){ return x.id === id; })[0] || {};
          self._invcfgFormModal(item);
        });
      } else {
        this._invcfgFormModal({});
      }
    },
    _invcfgFormModal(item) {
      var isEdit = !!item.id;
      var lrChecked = item.hasLeftRight ? ' checked' : '';
      var nameVal = M._esc(item.name || '');
      var skuVal = M._esc(item.sku || '');
      var iconVal = M._esc(item.icon || '');
      var modeVal = item.trackingMode === 'quantity' ? 'quantity' : 'sn';

      var lrRowStyle = modeVal === 'quantity' ? ' style="display:none;"' : ' style="display:flex;align-items:center;gap:8px;"';
      this.openModal(
        '<div class="m-modal-header"><div class="m-modal-title">' + (isEdit ? '编辑库存类型' : '添加库存类型') + '</div><button class="m-modal-close" onclick="M.closeModal()">×</button></div>' +
        '<div class="m-form-section">' +
        '<div class="m-field"><label class="m-field-label">物品名称 *</label><input id="m-invcfg-name" class="m-input" value="' + nameVal + '" placeholder="如：右手灵巧手"></div>' +
        '<div class="m-field"><label class="m-field-label">SKU 编码 *</label><input id="m-invcfg-sku" class="m-input" value="' + skuVal + '" placeholder="如：RIGHT-DEX-HAND" ' + (isEdit ? 'readonly' : '') + '></div>' +
        '<div class="m-field"><label class="m-field-label">图标（Emoji）</label><input id="m-invcfg-icon" class="m-input" value="' + iconVal + '" placeholder="如：🤖"></div>' +
        '<div class="m-field"><label class="m-field-label">跟踪模式</label>' +
        '<select id="m-invcfg-mode" class="m-input" onchange="M._invcfgModeChange()">' +
        '<option value="sn"' + (modeVal === 'sn' ? ' selected' : '') + '>SN 精细跟踪（逐件SN登记，任何物品可选用）</option>' +
        '<option value="quantity"' + (modeVal === 'quantity' ? ' selected' : '') + '>纯数量跟踪（耗材类，只记数量）</option>' +
        '</select></div>' +
        '<div class="m-field" id="m-invcfg-lr-row"' + lrRowStyle + '><input type="checkbox" id="m-invcfg-lr" style="width:18px;height:18px;"' + lrChecked + '><label class="m-field-label" style="margin:0;" for="m-invcfg-lr">左右手类型（仅SN精细跟踪）</label></div>' +
        '<div style="font-size:0.72rem;color:var(--muted);">品类已有库存数据后不可切换跟踪模式</div>' +
        '</div>' +
        '<div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">取消</button><button class="m-btn m-btn-primary" onclick="M._invcfgSave(\'' + M._esc(item.id || '') + '\')">保存</button></div>'
      );
    },
    _invcfgModeChange() {
      var sel = document.getElementById('m-invcfg-mode');
      var row = document.getElementById('m-invcfg-lr-row');
      var lr = document.getElementById('m-invcfg-lr');
      var isQty = !!(sel && sel.value === 'quantity');
      if (row) row.style.display = isQty ? 'none' : 'flex';
      if (lr && isQty) lr.checked = false;
    },
    async _invcfgSave(id) {
      var name = (document.getElementById('m-invcfg-name') && document.getElementById('m-invcfg-name').value || '').trim();
      var skuEl = document.getElementById('m-invcfg-sku');
      var sku = (skuEl && skuEl.value || '').trim();
      var icon = (document.getElementById('m-invcfg-icon') && document.getElementById('m-invcfg-icon').value || '').trim();
      var modeSel = document.getElementById('m-invcfg-mode');
      var trackingMode = modeSel && modeSel.value === 'quantity' ? 'quantity' : 'sn';

      var hasLeftRight = trackingMode === 'quantity' ? false : !!(document.getElementById('m-invcfg-lr') && document.getElementById('m-invcfg-lr').checked);
      if (!name) { this.toast('请输入物品名称','err'); return; }
      if (!id && !sku) { this.toast('请输入 SKU 编码','err'); return; }
      var r;
      if (id) {
        r = await API.updateInventoryConfigItem(id, { name: name, sku: sku, icon: icon, hasLeftRight: hasLeftRight, trackingMode: trackingMode });
      } else {
        r = await API.addInventoryConfigItem({ name: name, sku: sku, icon: icon, hasLeftRight: hasLeftRight, trackingMode: trackingMode });
      }
      if (r && r.success !== false) {
        this.closeModal();
        this.toast(id ? '已更新' : '已添加', 'ok');
        this._refreshInventoryConfigList();
        this.renderDeviceTab();
        this._loadCatLabels();
      } else {
        this.toast(r && (r.error || r.message) || '保存失败', 'err');
      }
    },
    async _invcfgDelete(id) {
      var go = await this._askConfirm('确认删除该库存类型？已产生的库存数据不受影响。', '删除库存类型');
      if (!go) return;
      var r = await API.deleteInventoryConfig(id);
      if (r && r.success !== false) { this.toast('已删除','ok'); this._refreshInventoryConfigList(); this.renderDeviceTab(); }
      else { this.toast(r && (r.error || r.message) || '删除失败','err'); }
    },
    async _invcfgExport() {
      var list = (await API.getInventoryConfig()) || [];
      var data = list.map(function(x){ return { name: x.name, sku: x.sku || x.id, icon: x.icon || '', hasLeftRight: !!x.hasLeftRight, trackingMode: x.trackingMode === 'quantity' ? 'quantity' : 'sn' }; });
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'inventory-config-' + new Date().toISOString().slice(0,10) + '.json';
      document.body.appendChild(a); a.click();
      setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); }, 100);
      this.toast('已导出 ' + data.length + ' 条配置','ok');
    },
    _invcfgImport() {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = async function() {
        var f = input.files && input.files[0];
        if (!f) return;
        try {
          var text = await f.text();
          var items = JSON.parse(text);
          if (!Array.isArray(items)) items = [items];
          var r = await API.importInventoryConfig(items);
          if (r && r.success !== false) {
            M.toast('导入完成：新增 ' + (r.added||0) + ' 项，更新 ' + (r.updated||0) + ' 项', 'ok');
            M._refreshInventoryConfigList();
            M.renderDeviceTab();
          } else {
            M.toast((r && (r.error || r.message)) || '导入失败', 'err');
          }
        } catch(e) {
          M.toast('导入失败：' + e.message, 'err');
        }
      };
      input.click();
    },

    _siState: { shift: 'morning', tab: 'all', q: '', status: 'all', data: null },
    async _renderShiftInspectionPage(wrap) {
      if (!wrap) return;
      var self = this;

      if (this._siTimer) { clearInterval(this._siTimer); this._siTimer = null; }
      this._siState = { shift: 'morning', tab: 'all', q: '', status: 'all', data: null };
      var html = '<div class="m-subpage-title">今日首检</div>';

      html += '<div id="m-si-banner"><div class="m-loading">加载中...</div></div>';

      html += '<div class="m-si-tabs" id="m-si-tabs">' +
        '<div class="m-si-tab" data-si-tab="all" onclick="M._setShiftInspectionTab(\'all\')">全部</div>' +
        '<div class="m-si-tab" data-si-tab="morning" onclick="M._setShiftInspectionTab(\'morning\')">早班</div>' +
        '<div class="m-si-tab" data-si-tab="night" onclick="M._setShiftInspectionTab(\'night\')">晚班</div>' +
        '</div>';

      html += '<div style="display:flex;gap:8px;margin:12px 0;align-items:center;">' +
        '<input id="m-si-search" class="m-input" style="flex:1;" placeholder="搜索设备编号">' +
        '<select id="m-si-status" class="m-select" style="flex:0 0 auto;width:104px;">' +
        '<option value="all">全部状态</option><option value="none">未首检</option><option value="in_progress">首检中</option><option value="completed">已完成</option>' +
        '</select></div>';
      html += '<div id="m-si-list"><div class="m-loading">加载中...</div></div>';
      wrap.innerHTML = html;
      var si = document.getElementById('m-si-search');
      if (si) si.oninput = function(){ self._siState.q = (this.value||'').trim().toLowerCase(); self._siRenderList(); };
      var st = document.getElementById('m-si-status');
      if (st) st.onchange = function(){ self._siState.status = this.value; self._siRenderList(); };
      await this._refreshShiftInspection();

      if (this._siTimer) clearInterval(this._siTimer);
      this._siTimer = setInterval(function(){ self._refreshShiftInspection(); }, 30000);
    },
    async _refreshShiftInspection() {
      var self = this;
      try {
        var r = await API.getTodayShiftInspections();
        if (!r || r.success === false) {
          var banner = document.getElementById('m-si-banner');
          if (banner) banner.innerHTML = '<div class="m-empty"><div class="m-empty-text">加载失败：' + (r && r.error || r && r.message || '未知错误') + '</div></div>';
          return;
        }
        this._siState.data = r;
        this._siRenderBanner();
        this._siRenderList();
      } catch(e) {
        banner = document.getElementById('m-si-banner');
        if (banner) banner.innerHTML = '<div class="m-empty"><div class="m-empty-text">加载失败：' + this._esc(e.message) + '</div></div>';
      }
    },
    _siRenderBanner() {
      var banner = document.getElementById('m-si-banner');
      if (!banner) return;
      var self = this;
      var r = this._siState.data;
      var info = r.shiftInfo || {};
      var m = r.machines || [];
      var now = new Date();
      var hh = ('0'+now.getHours()).slice(-2), mm = ('0'+now.getMinutes()).slice(-2);
      var periodLabel = { morning:'早班 08:00-17:00', night:'晚班 17:00-次日02:00', none:'休息时段 02:00-08:00' };
      var cur = info.current || 'morning';
      var morningDone = m.filter(function(x){ return x.morning && x.morning.status==='completed'; }).length;
      var nightDone = m.filter(function(x){ return x.night && x.night.status==='completed'; }).length;
      var total = m.length;
      var curColor = cur==='night' ? '#7c3aed' : (cur==='morning' ? '#2563eb' : '#888');
      banner.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:linear-gradient(135deg,'+curColor+',rgba(0,0,0,.15));border-radius:10px;color:#fff;margin:4px 0 10px;">'+
          '<div><div style="font-size:0.8rem;font-weight:600;">当前：'+periodLabel[cur]+'</div>'+
          '<div style="font-size:0.65rem;opacity:.85;margin-top:2px;">'+now.toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric'})+' '+(cur==='night'||cur==='none'?'':'· ')+hh+':'+mm+'</div></div>'+
          '<div style="text-align:right;font-size:0.7rem;line-height:1.5;">'+
            '<div>早班完成 <b>'+morningDone+'/'+total+'</b></div>'+
            '<div>晚班完成 <b>'+nightDone+'/'+total+'</b></div>'+
          '</div></div>';
      var tabs = document.querySelectorAll('#m-si-tabs .m-si-tab');
      tabs.forEach(function(t){ t.classList.toggle('active', t.getAttribute('data-si-tab')===self._siState.tab); });
    },
    _setShiftInspectionTab(tab) {
      this._siState.tab = tab;
      this._siRenderBanner();
      this._siRenderList();
    },
    _siShiftStatus(rec) {

      if (!rec) return ['未首检','empty'];
      if (rec.status === 'in_progress') return ['首检中','warn'];
      return ['已完成','ok'];
    },
    _siShiftBlock(title, color, rec, tabVisible, machineCode, shift) {
      var st = this._siShiftStatus(rec);
      var cls = st[1];
      var bg = cls==='ok' ? 'background:rgba(16,185,129,.12);border-left:3px solid #10b981;' :
              (cls==='warn' ? 'background:rgba(245,158,11,.12);border-left:3px solid #f59e0b;' :
              'background:var(--bg2);border-left:3px solid #9ca3af;');
      var h = '<div style="'+bg+'padding:8px 10px;border-radius:8px;margin-top:6px;">'+
        '<div style="display:flex;justify-content:space-between;align-items:center;">'+
        '<span style="font-weight:600;font-size:0.72rem;color:'+color+';">'+title+'</span>'+
        '<span class="m-badge m-badge-'+cls+'" style="font-size:0.65rem;">'+st[0]+'</span></div>';
      if (rec) {
        h += '<div style="font-size:0.65rem;color:var(--muted);margin-top:4px;">首检人：'+this._esc((rec.operatorName||rec.operator||'—'))+'（工号 '+this._esc((rec.operatorEmpId||rec.operator||'—'))+'）</div>'+
          '<div style="font-size:0.65rem;color:var(--muted);">时间：'+this._fmtTime(rec.createdAt)+'</div>';
        if (rec.note) h += '<div style="font-size:0.65rem;color:var(--muted);">备注：'+this._esc(rec.note)+'</div>';

        if (machineCode && shift) {
          if (rec.status === 'completed') {
            h += '<div style="margin-top:6px;"><button class="m-btn m-btn-xs m-btn-outline" onclick="M._editShiftInspection(\''+this._esc(machineCode)+'\',\''+shift+'\',\''+this._esc(rec.id)+'\')">重新首检</button></div>';
          } else if (rec.status === 'in_progress') {
            h += '<div style="margin-top:6px;"><button class="m-btn m-btn-xs m-btn-primary" onclick="M._showShiftInspectionModal(\''+this._esc(machineCode)+'\',\''+shift+'\',\''+this._esc(rec.id)+'\')">继续首检</button></div>';
          }
        }
      } else {
        h += '<div style="font-size:0.65rem;color:var(--muted);margin-top:4px;">尚未开始首检</div>';
      }
      h += '</div>';
      return h;
    },
    _siRenderList() {
      var list = document.getElementById('m-si-list');
      if (!list) return;
      var r = this._siState.data;
      if (!r || !r.machines) { list.innerHTML = '<div class="m-empty"><div class="m-empty-text">暂无数据</div></div>'; return; }
      var q = this._siState.q, stF = this._siState.status, tab = this._siState.tab;
      var machines = r.machines.filter(function(m){
        if (q && (m.machineNumber||'').toLowerCase().indexOf(q) === -1 && (m.deviceType||'').toLowerCase().indexOf(q) === -1) return false;
        if (stF === 'all') return true;

        var recA = tab==='night' ? m.night : m.morning;
        var recB = tab==='night' ? m.morning : m.night;
        var stA = recA ? recA.status : 'none';
        var stB = recB ? recB.status : 'none';
        if (stF === 'none') return stA === 'none' && stB === 'none';
        if (stF === 'in_progress') return stA === 'in_progress' || stB === 'in_progress';
        return stA === 'completed' || stB === 'completed';
      });
      if (!machines.length) {
        list.innerHTML = '<div class="m-empty"><div class="m-empty-text">没有符合条件的设备</div></div>';
        return;
      }
      var self = this;
      list.innerHTML = machines.map(function(m){
        var devTypeLabel = m.deviceType === 'glove_system' ? '手套系统' : (m.deviceType==='rehab_glove'?'wuji手套':(m.deviceType||'设备'));
        var online = m.status === 'online';
        var shiftBadge = m.status === 'online' ? '<span class="m-badge m-badge-ok" style="font-size:0.62rem;">在线</span>' : '<span class="m-badge" style="font-size:0.62rem;">离线</span>';
        var cardShift = tab==='all' ? '' : (tab==='night' ? '（晚班）' : '（早班）');
        var blocks = '';
        if (tab === 'all' || tab === 'morning') blocks += self._siShiftBlock('早班首检', '#2563eb', m.morning, tab==='all'||tab==='morning', m.machineNumber, 'morning');
        if (tab === 'all' || tab === 'night') blocks += self._siShiftBlock('晚班首检', '#7c3aed', m.night, tab==='all'||tab==='night', m.machineNumber, 'night');
        var activeRec = tab==='all' ? null : (tab==='night' ? m.night : m.morning);

        var btn = '';
        if (tab !== 'all') {
          if (activeRec && activeRec.status === 'completed') {
            btn = '<div style="margin-top:8px;display:flex;gap:6px;"><button class="m-btn m-btn-sm m-btn-outline" onclick="M._editShiftInspection(\''+self._esc(m.machineNumber)+'\',\''+(tab==='night'?'night':'morning')+'\',\''+self._esc(activeRec.id)+'\')">重新首检 / 修改</button></div>';
          } else if (activeRec && activeRec.status === 'in_progress') {
            btn = '<div style="margin-top:8px;display:flex;gap:6px;"><button class="m-btn m-btn-sm m-btn-primary" onclick="M._showShiftInspectionModal(\''+self._esc(m.machineNumber)+'\',\''+(tab==='night'?'night':'morning')+'\',\''+self._esc(activeRec.id)+'\')">继续 / 完成首检</button></div>';
          } else {
            btn = '<div style="margin-top:8px;display:flex;gap:6px;"><button class="m-btn m-btn-sm m-btn-primary" onclick="M._startShiftInspection(\''+self._esc(m.machineNumber)+'\',\''+(tab==='night'?'night':'morning')+'\')">开始首检</button></div>';
          }
        }
        return '<div class="m-card" style="margin-bottom:10px;padding:6px 10px;">'+
          '<div style="display:flex;justify-content:space-between;align-items:center;">'+
          '<span style="font-weight:600;font-size:0.85rem;">'+self._esc(m.machineNumber)+cardShift+'</span>'+shiftBadge+'</div>'+
          '<div style="font-size:0.7rem;color:var(--muted);margin:2px 0 4px;">'+self._esc(devTypeLabel)+'</div>'+
          blocks+
          btn+
          '<div style="margin-top:6px;text-align:right;"><span style="font-size:0.65rem;color:var(--text3);cursor:pointer;" onclick="M._showShiftInspectionHistory(\''+self._esc(m.machineNumber)+'\')">查看历史 ›</span></div>'+
          '</div>';
      }).join('');
    },

    async _showShiftInspectionHistory(machineCode) {
      var self = this;
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">首检历史 · '+this._esc(machineCode)+'</div><button class="m-modal-close" onclick="M.closeModal()">x</button></div>'+
        '<div class="m-form-section" id="m-si-history"><div style="text-align:center;padding:20px;">加载中...</div></div>');
      try {
        var r = await API.getMachineShiftInspections(machineCode);
        var list = (r && r.success && r.list) || [];
        var el = document.getElementById('m-si-history');
        if (!el) return;
        if (!list.length) {
          el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);font-size:0.8rem;">暂无首检记录</div>';
          return;
        }
        var shiftLabel = { morning: '<span style="color:#2563eb;">早班</span>', night: '<span style="color:#7c3aed;">晚班</span>' };
        el.innerHTML = '<div style="max-height:56vh;overflow-y:auto;">' + list.map(function(it){
          var stLabel = it.status==='in_progress' ? '<span class="m-badge m-badge-wrn" style="font-size:0.62rem;">首检中</span>' : '<span class="m-badge m-badge-ok" style="font-size:0.62rem;">已完成</span>';
          return '<div style="padding:8px 0;border-bottom:1px solid var(--border);">'+
            '<div style="display:flex;justify-content:space-between;align-items:center;">'+
            '<span style="font-size:0.78rem;font-weight:600;">'+(shiftLabel[it.shift]||'')+' '+stLabel+'</span>'+
            '<span style="font-size:0.65rem;color:var(--muted);">'+self._fmtTime(it.createdAt)+'</span></div>'+
            '<div style="font-size:0.68rem;color:var(--muted);margin-top:3px;">首检人：'+self._esc(it.operatorName||it.operator||'—')+'（工号 '+self._esc(it.operatorEmpId||it.operator||'—')+'）'+(it.note?' · '+self._esc(it.note):'')+'</div>'+
            '</div>';
        }).join('') + '</div>';
      } catch(e) {
        el = document.getElementById('m-si-history');
        if (el) el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);font-size:0.8rem;">加载失败</div>';
      }
    },

    _svTimer: null,
    async _renderServerDashboard(wrap) {
      if (!wrap) return;
      var self = this;
      if (this._svTimer) { clearInterval(this._svTimer); this._svTimer = null; }
      wrap.innerHTML = '<div class="m-subpage-title">服务器看板</div><div id="m-sv-body"><div class="m-loading">加载中...</div></div>';
      var render = async function(){
        var body = document.getElementById('m-sv-body');
        if (!body) return;
        try {
          var r = await API.getServerStatus();
          if (!r || !r.success) throw new Error('获取失败');
          var s = r.server, c = r.cpu, m = r.memory, p = r.pool;

          var fmtTime = function(sec){ var d=Math.floor(sec/86400),h=Math.floor(sec%86400/3600),mi=Math.floor(sec%3600/60),s2=sec%60; return (d>0?d+'天 ':'')+h+'时 '+mi+'分 '+s2+'秒'; };
          var fmtBytes = function(b){ if(b>=1073741824) return (b/1073741824).toFixed(1)+' GB'; if(b>=1048576) return (b/1048576).toFixed(1)+' MB'; if(b>=1024) return (b/1024).toFixed(1)+' KB'; return b+' B'; };
          var barPct = function(v){ return '<div class="m-sv-bar"><div class="m-sv-bar-fill" style="width:'+Math.min(100,Math.max(0,v))+'%"></div></div><div class="m-sv-pct">'+Math.round(v)+'%</div>'; };
          body.innerHTML =

            '<div class="m-sv-cards">'+
              '<div class="m-sv-card"><div class="m-sv-num m-sv-txt-ok">'+Math.round(c.usagePct)+'%</div><div class="m-sv-label">CPU 使用率</div></div>'+
              '<div class="m-sv-card"><div class="m-sv-num m-sv-txt-ok">'+Math.round(m.usagePct)+'%</div><div class="m-sv-label">内存使用率</div></div>'+
              '<div class="m-sv-card"><div class="m-sv-num m-sv-txt-ok">'+p.total+'<span class="m-sv-unit">/'+p.connectionLimit+'</span></div><div class="m-sv-label">连接池</div></div>'+
              '<div class="m-sv-card"><div class="m-sv-num m-sv-txt-ok">'+r.sseClients+'</div><div class="m-sv-label">实时连接</div></div>'+
            '</div>'+

            '<div class="m-sv-panel"><div class="m-sv-panel-title">CPU</div>'+
              '<div class="m-sv-row"><span class="m-sv-row-label">型号</span><span class="m-sv-row-val">'+self._esc(c.model)+'（'+c.cores+' 核）</span></div>'+
              '<div class="m-sv-row"><span class="m-sv-row-label">负载 1/5/15 分钟</span><span class="m-sv-row-val">'+c.loadAvg1.toFixed(2)+' / '+c.loadAvg5.toFixed(2)+' / '+c.loadAvg15.toFixed(2)+'</span></div>'+
              '<div class="m-sv-row"><div class="m-sv-row-label">使用率</div>'+barPct(c.usagePct)+'</div>'+
            '</div>'+

            '<div class="m-sv-panel"><div class="m-sv-panel-title">系统内存</div>'+
              '<div class="m-sv-row"><div class="m-sv-row-label">使用率</div>'+barPct(m.usagePct)+'</div>'+
              '<div class="m-sv-row"><span class="m-sv-row-label">已用 / 总计</span><span class="m-sv-row-val">'+fmtBytes(m.used)+' / '+fmtBytes(m.total)+'</span></div>'+
              '<div class="m-sv-row"><span class="m-sv-row-label">空闲</span><span class="m-sv-row-val">'+fmtBytes(m.free)+'</span></div>'+
            '</div>'+
            '<div class="m-sv-panel"><div class="m-sv-panel-title">Node 进程内存</div>'+
              '<div class="m-sv-row"><span class="m-sv-row-label">堆已用（RSS）</span><span class="m-sv-row-val">'+m.processHeapUsedMB+' MB / '+m.rssMB+' MB</span></div>'+
            '</div>'+

            '<div class="m-sv-panel"><div class="m-sv-panel-title">数据库连接池</div>'+
              '<div class="m-sv-grid2">'+
                '<div class="m-sv-mini"><div class="m-sv-mini-num">'+p.active+'</div><div class="m-sv-mini-label">活动连接</div></div>'+
                '<div class="m-sv-mini"><div class="m-sv-mini-num">'+p.idle+'</div><div class="m-sv-mini-label">空闲连接</div></div>'+
                '<div class="m-sv-mini"><div class="m-sv-mini-num">'+p.pending+'</div><div class="m-sv-mini-label">排队请求</div></div>'+
                '<div class="m-sv-mini"><div class="m-sv-mini-num">'+p.total+'</div><div class="m-sv-mini-label">总连接数</div></div>'+
              '</div>'+
              '<div class="m-sv-row"><div class="m-sv-row-label">连接使用率</div>'+barPct(p.total/p.connectionLimit*100)+'</div>'+
            '</div>'+

            '<div class="m-sv-panel"><div class="m-sv-panel-title">服务器信息</div>'+
              '<div class="m-sv-row"><span class="m-sv-row-label">版本</span><span class="m-sv-row-val">'+self._esc(s.version)+'</span></div>'+
              '<div class="m-sv-row"><span class="m-sv-row-label">Node</span><span class="m-sv-row-val">'+self._esc(s.node)+'</span></div>'+
              '<div class="m-sv-row"><span class="m-sv-row-label">系统</span><span class="m-sv-row-val">'+self._esc(s.platform)+' '+self._esc(s.arch)+'</span></div>'+
              '<div class="m-sv-row"><span class="m-sv-row-label">已运行</span><span class="m-sv-row-val">'+fmtTime(s.uptime)+'</span></div>'+
              '<div class="m-sv-row"><span class="m-sv-row-label">启动时间</span><span class="m-sv-row-val">'+self._fmtTime(s.startTime)+'</span></div>'+
              '<div class="m-sv-row"><span class="m-sv-row-label">刷新时间</span><span class="m-sv-row-val">'+self._fmtTime(r.timestamp)+'</span></div>'+
            '</div>'+
            '<div style="text-align:center;font-size:0.62rem;color:var(--muted);padding:8px 0 20px;">每 3 秒自动刷新</div>';
        } catch(e) {
          body.innerHTML = '<div class="m-empty"><div class="m-empty-text">获取服务器状态失败</div></div>';
        }
      };
      await render();
      this._svTimer = setInterval(render, 3000);
    },

    async _startShiftInspection(machineCode, shift) {
      var self = this;
      this.openModal(
        '<div class="m-modal-header"><div class="m-modal-title">开始'+ (shift==='night'?'晚班':'早班') +'首检</div><button class="m-modal-close" onclick="M.closeModal()">x</button></div>'+
        '<div class="m-form-section"><div class="m-section-title" style="margin-bottom:10px;">设备 '+this._esc(machineCode)+'</div>'+
        '<p style="font-size:0.8rem;color:var(--muted);line-height:1.6;">请确认即将开始'+(shift==='night'?'晚班（17:00-次日02:00）':'早班（08:00-17:00）')+'首检。<br>首检将记录 8 项设备状态检查，确认无误后开始？</p></div>'+
        '<div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">取消</button><button class="m-btn m-btn-primary" onclick="M._confirmStartShiftInspection(\''+self._esc(machineCode)+'\',\''+shift+'\')">确认开始</button></div>'
      );
    },
    async _confirmStartShiftInspection(machineCode, shift) {
      var r = await API.saveShiftInspection(machineCode, { shift: shift, status: 'in_progress', checklist: {}, note: '' });
      if (r && r.success !== false) {
        this.toast('已开始首检，请逐项检查设备');
        this.closeModal();
        this._refreshShiftInspection();

        this._showShiftInspectionModal(machineCode, shift, r.id);
      } else {
        this.toast((r && r.error) || '操作失败','err');
      }
    },

    _editShiftInspection(machineCode, shift, recordId) {
      var self = this;
      this.openModal(
        '<div class="m-modal-header"><div class="m-modal-title">修改'+(shift==='night'?'晚班':'早班')+'首检</div><button class="m-modal-close" onclick="M.closeModal()">x</button></div>'+
        '<div class="m-form-section"><div class="m-section-title" style="margin-bottom:10px;">设备 '+this._esc(machineCode)+'</div>'+
        '<p style="font-size:0.8rem;color:var(--muted);line-height:1.6;">该班次已完成首检。<br>如需修改检查项或备注，将覆盖原记录，确认继续？</p></div>'+
        '<div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">取消</button><button class="m-btn m-btn-primary" onclick="M.closeModal();M._showShiftInspectionModal(\''+self._esc(machineCode)+'\',\''+shift+'\',\''+self._esc(recordId)+'\')">继续修改</button></div>'
      );
    },

    _showShiftInspectionModal(machineCode, shift, recordId) {
      var self = this;
      var items = [
        ['questConnected',  'Quest 是否连接', '已连接', '未连接'],
        ['wristCamLConnected', '左手腕相机是否连接', '已连接', '未连接'],
        ['wristCamRConnected', '右手腕相机是否连接', '已连接', '未连接'],
        ['wristPageLMatched',  '左手腕相机页面是否匹配', '匹配', '不匹配'],
        ['wristPageRMatched',  '右手腕相机页面是否匹配', '匹配', '不匹配'],
        ['gloveLConnected', '左手套是否连接', '已连接', '未连接'],
        ['gloveRConnected', '右手套是否连接', '已连接', '未连接'],
        ['controllerBatteryOk', '手柄电池电量', '正常', '低电量'],
        ['overlayAvailable', 'overlay 是否可用', '可用', '不可用'],
        ['canProduce', '是否能正常生产', '可以', '不可以']
      ];

      var prev = null;
      if (recordId) {
        var r = this._siState && this._siState.data;
        if (r && r.machines) {
          for (var i = 0; i < r.machines.length; i++) {
            var mm = r.machines[i];
            if (mm.machineNumber === machineCode) {
              var rec = shift === 'night' ? mm.night : mm.morning;
              if (rec && rec.id === recordId) prev = rec;
            }
          }
        }
      }
      var rows = items.map(function(it){
        var selected = prev && prev.checklist && prev.checklist[it[0]] !== undefined
          ? (prev.checklist[it[0]] ? 'yes' : 'no')
          : 'yes';
        return '<div class="m-check-row"><div class="m-check-label">'+self._esc(it[1])+'</div>'+
          '<select class="m-select" id="m-si-'+it[0]+'" style="width:110px;flex-shrink:0;">'+
          '<option value="yes"'+('yes'===selected?' selected':'')+'>'+self._esc(it[2])+'</option>'+
          '<option value="no"'+('no'===selected?' selected':'')+'>'+self._esc(it[3])+'</option></select></div>';
      }).join('');
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">'+(shift==='night'?'晚班':'早班')+'首检 · '+this._esc(machineCode)+(prev&&prev.status==='completed'?'（修改）':'')+'</div><button class="m-modal-close" onclick="M.closeModal()">x</button></div>'+
        '<div class="m-form-section"><div class="m-section-title" style="margin-bottom:10px;">设备状态检查</div>'+
        rows +
        '<div class="m-field" style="margin-top:14px;"><label class="m-field-label">备注（可选）</label><textarea id="m-si-note" class="m-textarea" placeholder="异常情况说明等">'+self._esc((prev&&prev.note)||'')+'</textarea></div></div>'+
        '<div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">取消</button><button class="m-btn m-btn-primary" onclick="M._confirmCompleteShiftInspection(\''+this._esc(machineCode)+'\',\''+shift+'\',\''+this._esc(recordId||'')+'\')">确认提交</button></div>');
    },
    async _confirmCompleteShiftInspection(machineCode, shift, recordId) {
      var keys = ['questConnected','wristCamLConnected','wristCamRConnected','wristPageLMatched','wristPageRMatched','gloveLConnected','gloveRConnected','controllerBatteryOk','overlayAvailable','canProduce'];
      var checklist = {};
      keys.forEach(function(k){ checklist[k] = ((document.getElementById('m-si-'+k)||{}).value) === 'yes'; });
      var note = (document.getElementById('m-si-note')||{}).value || '';
      var r = await API.saveShiftInspection(machineCode, { shift: shift, status: 'completed', checklist: checklist, note: note, recordId: recordId || undefined });
      if (r && r.success !== false) {
        this.toast('首检已提交');
        this.closeModal();
        this._refreshShiftInspection();
      } else {
        this.toast((r && r.error) || '提交失败','err');
      }
    },

    async _renderDeliveryNotes(wrap) {
      if (!wrap) return;
      var self = this;
      wrap.innerHTML = '<div class="m-loading">加载发货单...</div>';
      var list;
      try {
        var r = await API.getDeliveryNotes();
        list = (r && Array.isArray(r)) ? r : [];
      } catch(e) {
        wrap.innerHTML = '<div class="m-empty"><div class="m-empty-text">加载失败：'+self._esc(e.message||'网络错误')+'</div><button class="m-btn m-btn-primary m-btn-sm" style="margin-top:12px;" onclick="M.showAdminSubPage(\'delivery-notes\')">重试</button></div>';
        return;
      }
      var typeLabel = { repair: '<span class="m-badge" style="background:#eff6ff;color:#2563eb;">送售后</span>', replacement: '<span class="m-badge" style="background:#fdf4ff;color:#a21caf;">置换发货</span>' };
      var html = '';

      html += '<div style="display:flex;gap:8px;margin-bottom:12px;">';
      html += '<button type="button" class="m-btn m-btn-primary m-btn-sm" style="flex:1;" onclick="M._createDeliveryNote()">+ 新建发货单</button>';
      html += '<button type="button" class="m-btn m-btn-outline m-btn-sm" style="flex:0.6;" onclick="M.showAdminSubPage(\'delivery-notes\')">刷新</button>';
      html += '</div>';
      if (!list.length) {
        html += '<div class="m-empty"><div class="m-empty-text">暂无发货记录</div><div class="m-text-sm m-text-muted" style="margin-top:8px;">通过 SN 状态操作（送售后）或置换发货可自动创建发货单，也可点击上方按钮手动创建</div></div>';
        wrap.innerHTML = html;
        return;
      }
      html += list.map(function(n){
        var count = (n.items||[]).length;
        var time = self._fmtTime(n.createdAt);
        var name = n.operatorName || n.operator || '—';
        var snPreview = (n.items||[]).slice(0,3).map(function(it){ return it.snCode||''; }).filter(Boolean).join(', ');
        if ((n.items||[]).length > 3) snPreview += '...';
        return '<div class="m-card" style="margin-bottom:10px;padding:12px 12px;cursor:pointer;" onclick="M._showDeliveryNoteDetail(\''+self._esc(n.id)+'\')">'+
          '<div style="display:flex;justify-content:space-between;align-items:center;">'+
          '<span style="font-weight:600;font-size:0.85rem;">'+(typeLabel[n.type]||typeLabel.repair)+'</span>'+
          '<span style="font-size:0.68rem;color:var(--muted);">'+time+'</span></div>'+
          '<div style="font-size:0.75rem;color:var(--text2);margin:6px 0;">SN：<b>'+count+'</b> 个'+(n.trackingNumber?' · 运单：'+self._esc(n.trackingNumber):'')+'</div>'+
          (snPreview ? '<div style="font-size:0.68rem;color:var(--muted);margin-bottom:4px;font-family:monospace;">'+self._esc(snPreview)+'</div>' : '')+
          '<div style="font-size:0.7rem;color:var(--muted);margin-bottom:8px;">发货人：'+self._esc(name)+'</div>'+
          '<div style="display:flex;gap:6px;">'+
          '<button type="button" class="m-btn m-btn-sm m-btn-primary" style="flex:1;" onclick="event.stopPropagation();M._showDeliveryNoteDetail(\''+self._esc(n.id)+'\')">查看详情</button>'+
          '<button type="button" class="m-btn m-btn-sm" style="flex:0.7;background:#10b981;color:#fff;" onclick="event.stopPropagation();M._printDeliveryNote(\''+self._esc(n.id)+'\')">打印</button>'+
          '<button type="button" class="m-btn m-btn-sm m-btn-outline" style="flex:0.5;color:#ef4444;" onclick="event.stopPropagation();M._deleteDeliveryNote(\''+self._esc(n.id)+'\')">删除</button>'+
          '</div></div>';
      }).join('');
      wrap.innerHTML = html;
    },
    async _showDeliveryNoteDetail(id) {
      this.openModal('<div class="m-loading">加载中...</div>');
      var r;
      try { r = await API.getDeliveryNote(id); } catch(e) { this.openModal('<div class="m-empty"><div class="m-empty-text">加载失败</div></div>'); return; }
      var note = r && r.note;
      if (!note) { this.closeModal(); this.toast('未找到发货单','err'); return; }
      var self = this;
      var typeLabel = note.type === 'replacement' ? '置换发货' : '送售后';
      var items = note.items || [];
      var rowsHtml = items.map(function(it, idx){
        return '<div style="display:flex;justify-content:space-between;padding:7px 4px;border-bottom:1px solid var(--border);font-size:0.78rem;">'+
          '<span>'+(idx+1)+'. <b style="font-family:monospace;">'+self._esc(it.snCode||'')+'</b></span>'+
          '<span style="color:var(--muted);">'+self._esc(it.eqLabel||it.equipmentType||'')+(it.handLabel?' · '+self._esc(it.handLabel):'')+'</span>'+
          '</div>';
      }).join('');
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">发货单 · '+this._esc(typeLabel)+'</div><button class="m-modal-close" onclick="M.closeModal()">\u00d7</button></div>'+
        '<div class="m-form-section">'+
        '<div class="m-detail-row"><div class="m-detail-label">发货单号</div><div class="m-detail-value" style="font-family:monospace;font-size:0.72rem;">'+this._esc(note.id)+'</div></div>'+
        '<div class="m-detail-row"><div class="m-detail-label">发货时间</div><div class="m-detail-value">'+this._fmtTime(note.createdAt)+'</div></div>'+
        '<div class="m-detail-row"><div class="m-detail-label">发货人</div><div class="m-detail-value">'+this._esc(note.operatorName||note.operator||'\u2014')+'</div></div>'+
        '<div class="m-detail-row"><div class="m-detail-label">发货单位</div><div class="m-detail-value">'+this._esc(note.company||'\u4e07\u8fbe\u667a\u6167\u624b\u5957')+'</div></div>'+
        '<div class="m-detail-row"><div class="m-detail-label">收货单位</div><div class="m-detail-value">'+this._esc(note.manufacturer||'\u2014')+'</div></div>'+
        (note.trackingNumber ? '<div class="m-detail-row"><div class="m-detail-label">运单号</div><div class="m-detail-value" style="font-family:monospace;">'+this._esc(note.trackingNumber)+'</div></div>' : '')+
        (note.note ? '<div class="m-detail-row"><div class="m-detail-label">备注</div><div class="m-detail-value">'+this._esc(note.note)+'</div></div>' : '')+
        '<div class="m-section-title" style="margin-top:12px;">发货清单（'+items.length+' 个 SN）</div>'+rowsHtml+
        '</div>'+
        '<div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">关闭</button>'+
        '<button class="m-btn m-btn-outline" onclick="M._editDeliveryNote(\''+self._esc(note.id)+'\')">编辑</button>'+
        '<button class="m-btn m-btn-primary" onclick="M._printDeliveryNote(\''+this._esc(note.id)+'\')">打印</button></div>');
    },

    async _createDeliveryNote() {
      this.openModal('<div class="m-loading">加载损坏库存...</div>');
      var damagedList;
      try {
        var all = await API.getSNRegistry();
        damagedList = (all||[]).filter(function(s){ return s.status === 'damaged'; });
      } catch(e) { damagedList = []; }
      var self = this;
      var snListHtml = '';
      if (damagedList.length) {
        snListHtml = '<div style="max-height:40vh;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:4px;">';
        damagedList.forEach(function(s){
          var sn = s.snCode || s.sn || s.id || '';
          var eqLabel = M._invLabel(s.equipmentType) || s.equipmentType || '手套';
          var hand = s.handType === 'right' ? '右手' : s.handType === 'left' ? '左手' : '-';
          var reason = s.damageReason ? ' · ' + s.damageReason : '';
          snListHtml += '<label style="display:flex;align-items:center;gap:8px;padding:8px 6px;border-bottom:1px solid var(--border);cursor:pointer;font-size:0.8rem;">'+
            '<input type="checkbox" class="m-dn-sn-check" value="'+self._esc(sn)+'" data-eq="'+self._esc(eqLabel)+'" data-eqtype="'+self._esc(s.equipmentType||'glove')+'" data-hand="'+self._esc(hand)+'" data-handtype="'+self._esc(s.handType||'')+'" style="width:18px;height:18px;flex-shrink:0;">'+
            '<div style="flex:1;min-width:0;"><div style="font-family:monospace;font-weight:600;">'+self._esc(sn)+'</div>'+
            '<div style="font-size:0.7rem;color:var(--muted);">'+self._esc(eqLabel)+' · '+self._esc(hand)+self._esc(reason)+'</div></div></label>';
        });
        snListHtml += '</div>';
        snListHtml += '<div style="display:flex;gap:6px;margin-top:6px;">'+
          '<button type="button" class="m-btn m-btn-sm m-btn-outline" onclick="M._dnSelectAll(true)">全选</button>'+
          '<button type="button" class="m-btn m-btn-sm m-btn-outline" onclick="M._dnSelectAll(false)">取消全选</button>'+
          '<span id="m-dn-sel-count" style="font-size:0.75rem;color:var(--muted);align-self:center;margin-left:auto;">已选 0 个</span></div>';
      } else {
        snListHtml = '<div class="m-empty" style="padding:20px;"><div class="m-empty-text">暂无损坏库存</div><div style="font-size:0.72rem;color:var(--muted);margin-top:6px;">可在下方手动输入 SN 码</div></div>';
      }
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">新建发货单</div><button class="m-modal-close" onclick="M.closeModal()">\u00d7</button></div>'+
        '<div class="m-form-section" style="max-height:75vh;overflow-y:auto;">'+
        '<div class="m-field"><label class="m-field-label">类型</label><select id="m-dn-new-type" class="m-select"><option value="repair">送售后</option><option value="replacement">置换发货</option></select></div>'+
        '<div class="m-field"><label class="m-field-label">发货单位</label><input id="m-dn-new-company" class="m-input" value="万达智慧手套"></div>'+
        '<div class="m-field"><label class="m-field-label">收货单位</label><input id="m-dn-new-manufacturer" class="m-input" placeholder="填写收货厂家"></div>'+
        '<div class="m-field"><label class="m-field-label">运单号</label><input id="m-dn-new-tracking" class="m-input" placeholder="快递单号（可选）"></div>'+
        '<div class="m-field"><label class="m-field-label">备注</label><input id="m-dn-new-note" class="m-input" placeholder="可选备注"></div>'+
        '<div class="m-field"><label class="m-field-label">从损坏库存选择（'+damagedList.length+' 个）</label>'+snListHtml+'</div>'+
        '<div class="m-field"><label class="m-field-label">或手动输入 SN 码（每行一个）</label><textarea id="m-dn-new-items" class="m-textarea" rows="3" placeholder="手动输入额外的 SN 码"></textarea></div>'+
        '</div><div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">取消</button><button class="m-btn m-btn-primary" onclick="M._submitNewDeliveryNote()">创建</button></div>');

      setTimeout(function(){
        var checks = document.querySelectorAll('.m-dn-sn-check');
        checks.forEach(function(cb){ cb.addEventListener('change', M._dnUpdateCount); });
        M._dnUpdateCount();
      }, 50);
    },
    _dnSelectAll(val) {
      var checks = document.querySelectorAll('.m-dn-sn-check');
      checks.forEach(function(cb){ cb.checked = val; });
      this._dnUpdateCount();
    },
    _dnUpdateCount() {
      var checks = document.querySelectorAll('.m-dn-sn-check:checked');
      var el = document.getElementById('m-dn-sel-count');
      if (el) el.textContent = '已选 ' + checks.length + ' 个';
    },
    async _submitNewDeliveryNote() {
      var type = (document.getElementById('m-dn-new-type')||{}).value||'repair';

      var checkedSNs = [];
      var checks = document.querySelectorAll('.m-dn-sn-check:checked');
      checks.forEach(function(cb){
        checkedSNs.push({
          snCode: cb.value,
          eqLabel: cb.getAttribute('data-eq') || '手套',
          equipmentType: cb.getAttribute('data-eqtype') || 'glove',
          handLabel: cb.getAttribute('data-hand') || '',
          handType: cb.getAttribute('data-handtype') || ''
        });
      });

      var manualCodes = ((document.getElementById('m-dn-new-items')||{}).value||'').split(/\r?\n/).map(function(v){return v.trim();}).filter(Boolean);

      var seen = {};
      var items = [];
      checkedSNs.forEach(function(it){ if (!seen[it.snCode]) { seen[it.snCode] = true; items.push(it); } });
      manualCodes.forEach(function(sn){ if (!seen[sn]) { seen[sn] = true; items.push({ snCode: sn, eqLabel: '手套', equipmentType: 'glove', handLabel: '', handType: '' }); } });
      if (!items.length) { this.toast('请从损坏库存选择或手动输入 SN 码','err'); return; }
      var payload = {
        type: type,
        items: items,
        trackingNumber: ((document.getElementById('m-dn-new-tracking')||{}).value||'').trim(),
        company: ((document.getElementById('m-dn-new-company')||{}).value||'').trim(),
        manufacturer: ((document.getElementById('m-dn-new-manufacturer')||{}).value||'').trim(),
        note: ((document.getElementById('m-dn-new-note')||{}).value||'').trim()
      };
      try {
        var dn = await API.saveDeliveryNote(payload);
        if (!dn || dn.success === false) { this.toast((dn&&(dn.error||dn.message))||'创建失败','err'); return; }

        var updatedCount = 0;
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          try {
            await API.upsertSNRegistry({ snCode: it.snCode, status: 'shipped', equipmentType: it.equipmentType || 'glove' });
            updatedCount++;
          } catch(e2) { console.warn('SN状态更新失败:', it.snCode, e2); }
        }
        this.closeModal();
        this.toast('发货单已创建' + (updatedCount ? '，' + updatedCount + '个SN已更新为发货维修中' : ''), 'ok');
        var dop = await this._askConfirm('发货单已保存，是否立即打印？', '打印发货单');
        if (dop) { M._printDeliveryNote(dn.id); return; }
        await M._renderDeliveryNotes(document.getElementById('m-subpage-content'));
      } catch(e) { this.toast('创建失败：'+(e.message||'网络错误'),'err'); }
    },
    async _editDeliveryNote(id) {
      var r = await API.getDeliveryNote(id);
      var note = r && r.note;
      if (!note) { this.toast('未找到发货单','err'); return; }
      var self = this;
      this._editingDeliveryNote = note;
      var items = note.items || [];
      var snText = items.map(function(item) { return item.snCode || item.sn || ''; }).join('\n');
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">编辑发货单</div><button class="m-modal-close" onclick="M.closeModal()">x</button></div>'+
        '<div class="m-form-section">'+
        '<div class="m-field"><label class="m-field-label">发货单位</label><input id="m-dn-company" class="m-input" value="'+self._esc(note.company || '万达智慧手套')+'"></div>'+
        '<div class="m-field"><label class="m-field-label">收货单位</label><input id="m-dn-manufacturer" class="m-input" value="'+self._esc(note.manufacturer || '')+'"></div>'+
        '<div class="m-field"><label class="m-field-label">运单号</label><input id="m-dn-tracking" class="m-input" value="'+self._esc(note.trackingNumber || '')+'"></div>'+
        '<div class="m-field"><label class="m-field-label">备注</label><input id="m-dn-note" class="m-input" value="'+self._esc(note.note || '')+'"></div>'+
        '<div class="m-field"><label class="m-field-label">SN 明细（每行一个）</label><textarea id="m-dn-items" class="m-textarea" rows="8">'+self._esc(snText)+'</textarea></div>'+
        '</div><div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">取消</button><button class="m-btn m-btn-primary" onclick="M._saveDeliveryNoteEdit()">保存</button></div>');
    },
    async _saveDeliveryNoteEdit() {
      var self = this;
      var note = this._editingDeliveryNote;
      if (!note) { this.toast('发货单已失效，请重新打开', 'err'); return; }
      var snCodes = ((document.getElementById('m-dn-items') || {}).value || '').split(/\r?\n/).map(function(value) { return value.trim(); }).filter(Boolean);
      if (!snCodes.length) { this.toast('至少保留一个 SN', 'err'); return; }
      var oldItems = note.items || [];
      var items = snCodes.map(function(snCode) {
        var old = oldItems.find(function(item) { return (item.snCode || item.sn || '') === snCode; });
        return old || { snCode: snCode, eqLabel: '手套', equipmentType: 'glove', handLabel: '', handType: '' };
      });
      var result = await API.updateDeliveryNote(note.id, {
        items: items,
        company: ((document.getElementById('m-dn-company') || {}).value || '').trim(),
        manufacturer: ((document.getElementById('m-dn-manufacturer') || {}).value || '').trim(),
        trackingNumber: ((document.getElementById('m-dn-tracking') || {}).value || '').trim(),
        note: ((document.getElementById('m-dn-note') || {}).value || '').trim()
      });
      if (!result || result.success === false) { this.toast((result && (result.error || result.message)) || '保存失败', 'err'); return; }
      this.closeModal();
      this.toast('发货单已更新', 'ok');
      await this._renderDeliveryNotes(document.getElementById('m-subpage-content'));
    },
    async _printDeliveryNote(id) {
      var r;
      try { r = await API.getDeliveryNote(id); } catch(e) { this.toast('获取发货单失败','err'); return; }
      var note = r && r.note;
      if (!note) { this.toast('未找到发货单','err'); return; }
      this.closeModal();

      var items = note.items || [];
      var params = new URLSearchParams();
      params.set('items', JSON.stringify(items));
      params.set('tracking', note.trackingNumber || '');
      params.set('orderNo', note.id || '');
      params.set('operator', note.operatorName || note.operator || '');
      params.set('creator', note.operatorName || note.operator || '');
      params.set('company', note.company || '万达智慧手套');
      params.set('manufacturer', note.manufacturer || '');
      if (note.createdAt) {
        var d = new Date(note.createdAt);
        params.set('date', d.getFullYear()+'年'+(d.getMonth()+1)+'月'+d.getDate()+'日');
      }
      var url = '/delivery-note.html?' + params.toString();

      var printWin = window.open(url, '_blank');
      if (!printWin) {

        this.toast('弹窗被拦截，正在跳转到打印页面...','err');
        setTimeout(function() { location.href = url; }, 800);
      }
    },
    async _deleteDeliveryNote(id) {
      var go = await this._askConfirm('确认删除该发货单？此操作不可恢复。', '删除发货单');
      if (!go) return;
      var r = await API.deleteDeliveryNote(id);
      if (r && r.success !== false) {
        this.toast('已删除','ok');
        await this._renderDeliveryNotes(document.getElementById('m-subpage-content'));
      } else {
        this.toast((r && r.message) || '删除失败','err');
      }
    },

    _filterMobileSols() {
      var q = (document.getElementById('m-sol-search')?.value || '').toLowerCase();
      var cat = document.getElementById('m-sol-cat')?.value || 'all';
      API.getSolutions().then(function(sols){
        sols = sols.filter(function(s){ return (cat==='all'||(s.category||'默认')===cat) && (!q||(s.title||'').toLowerCase().includes(q)||(s.description||'').toLowerCase().includes(q)||(s.tags||'').toLowerCase().includes(q)); });
        var list = document.getElementById('m-sol-list');
        if (!list) return;
        var isAdmin = (M.currentUser||{}).role==='admin'||(M.currentUser||{}).role==='superadmin';
        list.innerHTML = M._renderMobileSolList(sols, isAdmin);
      }).catch(function(){});
    },

    async _addSOP() {
      var title = (document.getElementById('m-sop-title')?.value||'').trim();
      var category = (document.getElementById('m-sop-category')?.value||'').trim()||'默认';
      var kind = document.getElementById('m-sop-kind')?.value || 'url';
      if (!title) { this.toast('标题不能为空','err'); return; }
      var payload = {title:title, category:category, kind:kind};
      if (kind === 'url') {
        var url = (document.getElementById('m-sop-url')?.value||'').trim();
        if (!url) { this.toast('链接不能为空','err'); return; }
        payload.url = url;
      } else if (kind === 'text') {
        var content = (document.getElementById('m-sop-text')?.value||'').trim();
        if (!content) { this.toast('内容不能为空','err'); return; }
        payload.content = content;
      } else if (kind === 'file') {
        var fileInput = document.getElementById('m-sop-file');
        var file = fileInput?.files?.[0];
        if (!file) { this.toast('请选择文件','err'); return; }
        var dataUrl = await API.uploadSOPFile(file);
        payload.content = dataUrl;
        payload.mime = file.type;
      }
      var r = await API.addSOP(payload);
      console.log('[SOP] add result:', JSON.stringify(r));
      if (r && r.success!==false) { this.toast('添加成功','ok'); this.showAdminSubPage('sop'); }
      else {
        var errMsg = r ? (r.error||r.message||JSON.stringify(r)) : '请求失败（网络/认证）';
        console.error('[SOP] add failed:', errMsg);
        this.toast(errMsg, 'err');
      }
    },
    async _deleteSOP(id) {
      var r = await API.deleteSOP(id);
      if (r && r.success !== false) { this.toast('已删除','ok'); this.showAdminSubPage('sop'); }
      else this.toast((r&&(r.error||r.message))||'删除失败','err');
    },

    async renderProfile() {
      var wrap = document.getElementById('m-me-content');
      if (!wrap) return;
      var user = this.currentUser||{};
      try { var me = await API._fetch('GET','/api/me'); if (me&&!me.error) user = me; } catch(e){}
      var ri = this._roleI(user.role);
      var initial = (user.displayName||user.username||'?').charAt(0).toUpperCase();
      var dept = user.system==='operations'?'运营':'运维';
      wrap.innerHTML =
        '<div class="m-profile-card"><div class="m-profile-initial">'+initial+'</div><div class="m-profile-name">'+this._esc(user.displayName||user.username)+'</div><div class="m-profile-meta">@'+this._esc(user.username)+' &middot; '+ri.l+' &middot; '+dept+'</div></div>'+
        '<div class="m-menu-group">'+
          '<div class="m-menu-item" onclick="M._showMyProfile()"><div class="m-menu-text">个人资料</div><div class="m-list-arrow">&rsaquo;</div></div>'+
          '<div class="m-menu-item" onclick="M.showNotifications()"><div class="m-menu-text">消息通知</div><div class="m-list-arrow">&rsaquo;</div></div>'+
          '<div class="m-menu-item" onclick="M._showMyActivity()"><div class="m-menu-text">操作记录</div><div class="m-list-arrow">&rsaquo;</div></div>'+
        '</div>'+
        '<div class="m-menu-group">'+
          '<div class="m-menu-item" onclick="M.showHelpCenter()"><div class="m-menu-text">帮助中心</div><div class="m-list-arrow">&rsaquo;</div></div>'+
           '<div class="m-menu-item" onclick="M.showChangePasswordForm()"><div class="m-menu-text">修改密码</div><div class="m-list-arrow">&rsaquo;</div></div>'+
        '</div>'+
        '<div class="m-menu-group">'+
          '<div class="m-menu-item" onclick="M.doLogout()" style="color:#ef4444"><div class="m-menu-text">退出登录</div><div class="m-list-arrow">&rsaquo;</div></div>'+
        '</div>'+
        '<div class="m-text-sm m-text-muted" style="text-align:center;padding:16px 0">GMS v'+APP_VERSION+'</div>';
    },
    showChangePasswordForm() {
      this.showSubPage('修改密码', function(content){
        content.innerHTML = '<div class="m-form-section"><div class="m-field"><label class="m-field-label">旧密码</label><input id="m-chpwd-old" class="m-input" type="password" autocomplete="current-password" placeholder="输入当前密码"></div>'+
          '<div class="m-field"><label class="m-field-label">新密码</label><input id="m-chpwd-new" class="m-input" type="password" autocomplete="new-password" placeholder="至少6位，包含字母和数字"></div>'+
          '<div class="m-field"><label class="m-field-label">确认新密码</label><input id="m-chpwd-confirm" class="m-input" type="password" autocomplete="new-password" placeholder="再次输入新密码"></div>'+
          '<div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.hideSubPageView()">取消</button><button class="m-btn m-btn-primary" onclick="M._submitChangePassword()">保存</button></div></div>';
      });
    },
    async _submitChangePassword() {
      var oldPassword = (document.getElementById('m-chpwd-old') || {}).value || '';
      var newPassword = (document.getElementById('m-chpwd-new') || {}).value || '';
      var confirmPassword = (document.getElementById('m-chpwd-confirm') || {}).value || '';
      if (!oldPassword || !newPassword || !confirmPassword) { this.toast('请填写所有字段', 'err'); return; }
      if (newPassword !== confirmPassword) { this.toast('两次输入的新密码不一致', 'err'); return; }
      if (newPassword.length < 6 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) { this.toast('新密码至少6位，且需包含字母和数字', 'err'); return; }
      try {
        var res = await fetch((API.baseURL || '') + '/api/change-password', { method: 'POST', headers: API._headers(), body: JSON.stringify({ oldPassword: oldPassword, newPassword: newPassword }) });
        var data = await res.json();
        if (!res.ok) { this.toast(data.error || '密码修改失败', 'err'); return; }
        this.hideSubPageView(); this.toast('密码修改成功', 'ok');
      } catch (e) { this.toast('网络错误，请稍后重试', 'err'); }
    },
    _showMyProfile() {
      var u = this.currentUser||{};
      var fields = [
        ['用户名',u.username],['姓名',u.displayName||u.username],['角色',this._roleI(u.role).l],
        ['系统',u.system==='operations'?'运营':'运维'],['邮箱',u.email||'-'],['手机',u.phone||'-'],
        ['部门',u.department||'-'],['最后登录',u.lastLoginAt?this._fmtTime(u.lastLoginAt):'-'],
        ['IP',u.lastIp||'-'],['创建时间',u.createdAt?this._fmtTime(u.createdAt):'-']
      ];
      this.showSubPage('个人资料', function(content){
        content.innerHTML = '<div class="m-form-section">'+fields.map(function(f){return '<div class="m-detail-row"><div class="m-detail-label">'+M._esc(f[0])+'</div><div class="m-detail-value">'+M._esc(f[1])+'</div></div>';}).join('')+'</div>';
      });
    },
    async _showMyActivity() {
      this.showSubPage('操作记录', function(content){
        content.innerHTML = '<div class="m-loading">加载中...</div>';
        var wrap = content;
        (async function(){
          try {
            var u = (M.currentUser||{}).username;
            var all = await API.getTransactions(200);
            var mine = (all||[]).filter(function(t){return (t.userName||t.user||t.updatedBy||'')===u;});
            if (!mine.length) { wrap.innerHTML='<div class="m-empty"><div class="m-empty-text">暂无记录</div></div>'; return; }
            wrap.innerHTML = mine.slice(0,50).map(function(t){return '<div class="m-data-row"><div><div class="m-data-value">'+M._esc(t.type||t.note||'操作')+'</div><div class="m-data-label">'+M._fmtTime(t.timestamp||t.createdAt)+' &middot; '+M._esc(t.updatedBy||t.userName||'')+'</div></div></div>';}).join('');
          } catch(e) { wrap.innerHTML = '<div class="m-empty"><div class="m-empty-text">加载失败</div></div>'; }
        })();
      });
    },
    showNotifications() {
      this.showSubPage('消息通知', function(content){
        content.innerHTML = '<div class="m-empty" onclick="M.hideSubPageView()" style="cursor:pointer"><div class="m-empty-text">暂无新消息</div><div class="m-text-sm m-text-muted" style="margin-top:8px">点击此处返回</div></div>';
      });
    },
    _showHelp() {
      this.showSubPage('帮助中心', function(content){
        content.innerHTML = '<div class="m-form-section"><div class="m-detail-row"><div class="m-detail-label">版本</div><div class="m-detail-value">GMS v'+APP_VERSION+'</div></div><div class="m-detail-row"><div class="m-detail-label">反馈</div><div class="m-detail-value">通过技术支持提交</div></div></div>';
      });
    },

    showHelpCenter() {
      var self = this;

      if ((this.currentUser.username||'').toLowerCase() === 'wuzhenyu') {
        this.showSubPage('帮助中心', function(content){
          content.innerHTML = '<div class="m-empty" style="padding:60px 20px"><div class="m-empty-text" style="font-size:16px">你是客服管理员</div>'+
            '<div class="m-text-sm m-text-muted" style="margin-top:12px;text-align:center">请使用首页右下角的 <strong>消息</strong> 悬浮按钮查看用户消息</div>'+
            '<button class="m-btn m-btn-primary m-btn-block" style="max-width:220px;margin:24px auto 0" onclick="M.hideSubPageView();M._showConversations()">前往消息列表</button></div>';
        });
        return;
      }
      this._chatTarget = null;
      this.showSubPage('帮助中心 · 在线客服', function(content){
        content.innerHTML = '<div class="m-loading">加载中...</div>';
        (async function(){
          try {

            var wz = await API.getChatHelpdesk();
            if (!wz) { content.innerHTML = '<div class="m-empty"><div class="m-empty-text">未找到客服账号，请联系管理员</div></div>'; return; }
            self._chatTarget = { id: wz.id, name: wz.displayName || wz.username };

            var history = (await API.getChatHistory(self._chatTarget.id))||[];
            content.innerHTML =
              '<div class="m-chat-container">'+
                '<div class="m-chat-body" id="m-chat-body">'+
                  (history.length ? history.map(function(m){ return self._chatBubble(m); }).join('') : '<div class="m-empty"><div class="m-empty-text">暂无聊天记录，发个消息联系客服吧</div></div>')+
                '</div>'+
                '<div class="m-chat-inputbar">'+
                  '<input id="m-chat-input" type="text" placeholder="输入消息..." class="m-chat-input" onkeydown="if(event.key===\'Enter\')M._sendChatMessage()">'+
                  '<button class="m-chat-send" onclick="M._sendChatMessage()">发送</button>'+
                '</div>'+
              '</div>';
            self._scrollChatToBottom();
          } catch(e) {
            content.innerHTML = '<div class="m-empty"><div class="m-empty-text">加载失败</div></div>';
          }
        })();
      });
    },
    _uid() {
      return this.currentUser && (this.currentUser.id || this.currentUser.userId);
    },
    _chatBubble(m) {
      var mine = m.senderId === this._uid();
      var time = this._fmtTime(m.createdAt) || '';
      return '<div class="m-chat-row '+(mine?'m-chat-mine':'m-chat-other')+'">'+
        '<div class="m-chat-bubble">'+this._esc(m.message||'')+
        '<div class="m-chat-time">'+this._esc(time)+'</div></div></div>';
    },
    async _sendChatMessage() {
      if (!this._chatTarget) { this.toast('客服连接失败','err'); return; }
      var input = document.getElementById('m-chat-input');
      var text = (input && input.value||'').trim();
      if (!text) return;
      var r = await API.sendChatMessage(this._chatTarget.id, this._chatTarget.name, text);
      if (r.success !== false) {
        if (input) input.value = '';

        var body = document.getElementById('m-chat-body');
        if (body) {
          var mine = this._chatBubble({ senderId: this._uid(), senderName: this.currentUser.displayName||this.currentUser.username, message: text, createdAt: new Date().toISOString() });
          body.insertAdjacentHTML('beforeend', mine);
          this._scrollChatToBottom();
        }
      } else {
        this.toast(r.message||r.error||'发送失败','err');
      }
    },
    _appendChatMessage(m) {
      var body = document.getElementById('m-chat-body');
      if (!body) return;

      var existing = body.querySelectorAll('.m-chat-bubble');

      var last = body.lastElementChild;
      if (last && last.getAttribute('data-msg-id') === m.id) return;
      body.insertAdjacentHTML('beforeend', '<div data-msg-id="'+this._esc(m.id||'')+'">'+this._chatBubble(m)+'</div>');
      this._scrollChatToBottom();
    },
    _scrollChatToBottom() {
      var body = document.getElementById('m-chat-body');
      if (body) setTimeout(function(){ body.scrollTop = body.scrollHeight; }, 50);
    },

    _ensureChatFloat() {
      if (document.getElementById('m-chat-float')) return;
      var btn = document.createElement('div');
      btn.id = 'm-chat-float';
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span class="m-chat-badge" id="m-chat-badge"></span>';
      btn.onclick = function() { M._showConversations(); };
      document.body.appendChild(btn);
      this._updateChatBadge();
    },

    async _updateChatBadge() {
      var badge = document.getElementById('m-chat-badge');
      if (!badge) return;
      try {
        var convs = (await API.getChatConversations()) || [];
        var total = convs.reduce(function(s, c) { return s + (c.unread || 0); }, 0);
        badge.textContent = total > 0 ? (total > 99 ? '99+' : total) : '';
        badge.style.display = total > 0 ? '' : 'none';
      } catch(e) { badge.style.display = 'none'; }
    },

    _showConversations() {
      var self = this;
      this.showSubPage('消息', function(content) {
        content.innerHTML = '<div class="m-loading">加载中...</div>';
        self._renderConversationList(content);
      });
    },

    async _renderConversationList(wrap) {
      var self = this;
      try {
        var convs = (await API.getChatConversations()) || [];
        if (convs.length === 0) {
          wrap.innerHTML = '<div class="m-empty"><div class="m-empty-text">暂无消息</div></div>';
          return;
        }
        wrap.innerHTML = convs.map(function(c) {
          var avatar = (c.userName || '?')[0];
          var time = M._fmtTime(c.lastTime) || '';
          var unreadBadge = (c.unread || 0) > 0 ? '<span class="m-badge m-badge-danger">' + (c.unread > 99 ? '99+' : c.unread) + '</span>' : '';
          return '<div class="m-data-row" onclick="M._openChatConversation(\'' + M._esc(c.userId) + '\',\'' + M._esc(c.userName || '未知') + '\')">' +
            '<div class="m-card-row"><div style="display:flex;align-items:center;gap:12px;">' +
            '<div class="m-avatar-sm">' + M._esc(avatar) + '</div>' +
            '<div><div class="m-data-value">' + M._esc(c.userName || '未知') + '</div>' +
            '<div class="m-data-label m-text-ellipsis">' + M._esc(c.lastMessage || '') + '</div></div></div>' +
            '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">' +
            '<div class="m-text-sm m-text-muted">' + time + '</div>' + unreadBadge + '</div></div></div>';
        }).join('');
      } catch(e) {
        wrap.innerHTML = '<div class="m-empty"><div class="m-empty-text">加载失败</div></div>';
      }
    },

    _openChatConversation(userId, userName) {
      var self = this;
      this.showSubPage('与 ' + (userName || '未知') + ' 聊天', function(content) {
        content.innerHTML = '<div class="m-loading">加载中...</div>';
        (async function() {
          try {

            await API.markChatRead(userId);
            await self._updateChatBadge();
            var history = (await API.getChatHistory(userId)) || [];
            content.innerHTML =
              '<div class="m-chat-container">' +
                '<div class="m-chat-body" id="m-chat-body">' +
                  (history.length ? history.map(function(m) { return self._chatBubble(m); }).join('') : '<div class="m-empty"><div class="m-empty-text">暂无聊天记录</div></div>') +
                '</div>' +
                '<div class="m-chat-inputbar">' +
                  '<input id="m-chat-input" type="text" placeholder="输入消息..." class="m-chat-input" onkeydown="if(event.key===\'Enter\')M._sendChatReply(\'' + M._esc(userId) + '\',\'' + M._esc(userName || '') + '\')">' +
                  '<button class="m-chat-send" onclick="M._sendChatReply(\'' + M._esc(userId) + '\',\'' + M._esc(userName || '') + '\')">发送</button>' +
                '</div>' +
              '</div>';
            self._scrollChatToBottom();
          } catch(e) {
            content.innerHTML = '<div class="m-empty"><div class="m-empty-text">加载失败</div></div>';
          }
        })();
      });
    },

    async _sendChatReply(recipientId, recipientName) {
      var input = document.getElementById('m-chat-input');
      var text = (input && input.value || '').trim();
      if (!text) return;
      var r = await API.sendChatMessage(recipientId, recipientName, text);
      if (r.success !== false) {
        if (input) input.value = '';
        var body = document.getElementById('m-chat-body');
        if (body) {
          body.insertAdjacentHTML('beforeend', this._chatBubble({ senderId: this._uid(), senderName: this.currentUser.displayName || this.currentUser.username, message: text, createdAt: new Date().toISOString() }));
          this._scrollChatToBottom();
        }
      } else {
        this.toast(r.message || '发送失败', 'err');
      }
    },

    showGlobalSearch() {
      this.showSubPage('搜索', function(content){
        content.innerHTML =
          '<div class="m-search-bar" style="margin:12px 0;padding:0 16px;">'+
            '<svg class="m-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>'+
            '<input id="m-global-search-input" class="m-search-input" type="text" placeholder="搜索设备、机器、技术支持、SN码..." oninput="M._doGlobalSearch()" autofocus>'+
          '</div>'+
          '<div id="m-global-search-results"></div>';

        setTimeout(function(){ var el=document.getElementById('m-global-search-input'); if(el)el.focus(); }, 100);
      });
    },
    async _doGlobalSearch() {
      var q = (document.getElementById('m-global-search-input')||{}).value||'';
      var wrap = document.getElementById('m-global-search-results');
      if (!wrap) return;
      if (!q.trim()) { wrap.innerHTML = ''; return; }
      var lq = q.trim().toLowerCase();

      var machines = this.machineList||[];
      var sn = this.snRegistry||[];
      var tickets = this.ticketList||[];
      var inventory = [];
      try { inventory = await API.getAllInventory(); } catch(e){}
      try { if (!machines.length) machines = await API.getMachines(); } catch(e){}
      try { if (!sn.length) sn = await API.getSNRegistry(); } catch(e){}
      try { if (!tickets.length) tickets = await API.getTechSupportList(); } catch(e){}

      var results = { 设备: [], 机器: [], 技术支持: [], SN码: [] };

      (inventory||[]).forEach(function(i){
        var name = M._invLabel(i.type||i.equipmentType);
        if (name.toLowerCase().indexOf(lq)>=0 || (i.type||'').toLowerCase().indexOf(lq)>=0) {
          results['设备'].push('<div class="m-data-row" onclick="M.showInventoryDetail(\''+M._esc(i.type||'')+'\')"><div class="m-data-value">'+M._esc(name)+'</div><div class="m-data-label">库存：'+(i.quantity||0)+'</div></div>');
        }
      });

      (machines||[]).forEach(function(m){
        var num = m.machineNumber||m.id||'';
        if (num.toLowerCase().indexOf(lq)>=0) {
          var s = m.displayStatus||m.status||'offline';
          var si = M._machineSI(s);
          results['机器'].push('<div class="m-data-row" onclick="M.showMachineDetail(\''+M._esc(num)+'\')"><div class="m-data-value">'+M._esc(num)+'</div><div class="m-data-label">状态：<span class="m-badge '+si.c+'">'+si.l+'</span></div></div>');
        }
      });

      (tickets||[]).forEach(function(t){
        var dev = t.machineNumber||t.machineId||t.equipmentTypeName||'';
        var desc = t.faultType||t.faultDescription||'';
        if (dev.toLowerCase().indexOf(lq)>=0 || desc.toLowerCase().indexOf(lq)>=0) {
          var si = M._ticketSI(t.status);
          results['技术支持'].push('<div class="m-data-row" onclick="M.showTicketDetail(\''+M._esc(t.id)+'\')"><div class="m-data-value">'+M._esc(dev)+'</div><div class="m-data-label">'+M._esc(desc)+'<span class="m-badge '+si.c+'" style="margin-left:6px">'+si.l+'</span></div></div>');
        }
      });

      (sn||[]).forEach(function(s){
        var code = s.snCode||s.sn||s.id||'';
        if (code.toLowerCase().indexOf(lq)>=0) {
          var si = M._snSI(s.status);
          results['SN码'].push('<div class="m-data-row"><div class="m-data-value">'+M._esc(code)+'</div><div class="m-data-label">'+M._esc(s.equipmentType||'-')+' · <span class="m-badge '+si.c+'">'+si.l+'</span></div></div>');
        }
      });

      var html = '';
      var cats = ['设备','机器','技术支持','SN码'];
      cats.forEach(function(cat){
        var items = results[cat];
        if (items.length) {
          html += '<div class="m-section-title">'+cat+' ('+items.length+')</div>'+items.slice(0,10).join('');
        }
      });
      if (!html) html = '<div class="m-empty"><div class="m-empty-text">未找到匹配结果</div></div>';
      wrap.innerHTML = html;
    },

    async showInventoryDetail(type) {
      var item = ((await API.getAllInventory())||[]).filter(function(x){ return (x.type||x.equipmentType)===type; })[0];
      if (!item) return;
      var name = this._invLabel(type);
      var rows = [['设备类型', name], ['总数量', item.quantity||0], ['可用', item.available||0], ['使用中', item.inUse||0], ['损坏', item.damaged||0], ['维修中', item.inRepair||0], ['已转出', item.transferred||0], ['更新人', item.updatedBy||'-'], ['更新时间', this._fmtTime(item.updatedAt)]];
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">'+this._esc(name)+'库存详情</div><button class="m-modal-close" onclick="M.closeModal()">×</button></div><div class="m-form-section">'+rows.map(function(r){return '<div class="m-detail-row"><div class="m-detail-label">'+M._esc(r[0])+'</div><div class="m-detail-value">'+M._esc(r[1])+'</div></div>';}).join('')+'</div><div class="m-btn-row"><button class="m-btn m-btn-primary" onclick="M.showInventoryAction(\''+M._esc(type)+'\')">调整库存</button><button class="m-btn m-btn-outline" onclick="M.closeModal()">关闭</button></div>');
    },
    showInventoryAction(type) {
      var name = this._invLabel(type);
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">调整'+this._esc(name)+'</div><button class="m-modal-close" onclick="M.closeModal()">×</button></div><div class="m-form-section"><div class="m-field"><label class="m-field-label">操作</label><select id="m-inv-direction" class="m-input"><option value="in">入库</option><option value="out">出库</option></select></div><div class="m-field"><label class="m-field-label">数量</label><input id="m-inv-qty" class="m-input" type="number" min="1" value="1"></div><div class="m-field"><label class="m-field-label">SN码（选填）</label><input id="m-inv-sn" class="m-input" placeholder="输入 SN 码"></div></div><div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">取消</button><button class="m-btn m-btn-primary" onclick="M._submitInventoryAction(\''+this._esc(type)+'\')">确认</button></div>');
    },
    async _submitInventoryAction(type) {
      var qty = parseInt(document.getElementById('m-inv-qty').value, 10)||0;
      var direction = document.getElementById('m-inv-direction').value;
      var sn = document.getElementById('m-inv-sn').value.trim();
      if (qty < 1) { this.toast('数量必须大于 0','err'); return; }

      var whId = this._whFilter || '';
      var result = await API.adjustInventory(type, direction==='in'?qty:-qty, (this.currentUser||{}).username||'', sn, whId || undefined);
      if (!result || result.success === false) { this.toast((result&&result.message)||'库存调整失败','err'); return; }
      this.closeModal(); this.toast('库存调整成功','ok'); this.renderDeviceTab();
    },

    openModal(html) {
      var m = document.getElementById('m-modal'), b = document.getElementById('m-modal-body');
      if (!m||!b) return;
      b.innerHTML = html; m.style.display = 'flex';
    },
    closeModal() {
      var m = document.getElementById('m-modal'); if (m) m.style.display = 'none';
      if (this._armConfirmResolve) this._armConfirmResolve(false);
      var s = document.getElementById('m-cmd-sheet'); if (s) s.remove();
      if (this._galioTimer) { clearInterval(this._galioTimer); this._galioTimer = null; }
      if (this._armResultTimer) { clearTimeout(this._armResultTimer); this._armResultTimer = null; }
      this._galioCache = null;
    },
    toast(msg, type) {
      var t = document.getElementById('m-toast');
      if (!t) return;
      t.textContent = msg; t.className = 'm-toast show'+(type?' m-toast-'+type:'');
      clearTimeout(this._tid); this._tid = setTimeout(function(){t.className='m-toast';},5000);
    },

    _askConfirm(msgHtml, title) {
      var self = this;
      return new Promise(function(resolve){
        self.openModal('<div class="m-modal-header"><div class="m-modal-title">'+self._esc(title||'确认操作')+'</div><button class="m-modal-close" onclick="M._askResolve(false)">×</button></div>'+
          '<div class="m-form-section"><p style="font-size:0.85rem;color:var(--text2);line-height:1.7;">'+msgHtml+'</p></div>'+
          '<div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M._askResolve(false)">取消</button><button class="m-btn m-btn-primary" onclick="M._askResolve(true)">确认</button></div>');
        self._askCb = resolve;
      });
    },
    // 机械臂确认层叠加在控制面板之上，保持 m-arm-result 可用。
    _armConfirm(msgHtml, title) {
      var self = this;
      return new Promise(function(resolve) {
        var old = document.getElementById('m-arm-confirm');
        if (old) old.remove();
        var overlay = document.createElement('div');
        overlay.id = 'm-arm-confirm';
        overlay.className = 'm-arm-confirm-overlay';
        overlay.innerHTML = '<div class="m-arm-confirm-mask"></div>' +
          '<div class="m-arm-confirm-panel" role="dialog" aria-modal="true">' +
          '<div class="m-modal-header"><div class="m-modal-title">' + self._esc(title || '确认操作') + '</div>' +
          '<button class="m-modal-close" type="button" aria-label="关闭">×</button></div>' +
          '<div class="m-form-section"><p style="font-size:0.85rem;color:var(--text2);line-height:1.7;">' + msgHtml + '</p></div>' +
          '<div class="m-btn-row"><button class="m-btn m-btn-outline" type="button" data-arm-confirm="cancel">取消</button>' +
          '<button class="m-btn m-btn-primary" type="button" data-arm-confirm="ok">确认</button></div></div>';
        document.body.appendChild(overlay);
        var finish = function(value) {
          if (self._armConfirmResolve !== finish) return;
          self._armConfirmResolve = null;
          overlay.remove();
          resolve(value);
        };
        self._armConfirmResolve = finish;
        overlay.addEventListener('click', function(event) {
          var target = event.target;
          if (target === overlay || target.classList.contains('m-arm-confirm-mask') ||
              target.closest('[data-arm-confirm="cancel"]') || target.closest('.m-modal-close')) {
            finish(false);
          } else if (target.closest('[data-arm-confirm="ok"]')) {
            finish(true);
          }
        });
        setTimeout(function() {
          var ok = overlay.querySelector('[data-arm-confirm="ok"]');
          if (ok) ok.focus();
        }, 0);
      });
    },
    _askText(msgHtml, title, placeholder) {
      var self = this;
      return new Promise(function(resolve){
        self.openModal('<div class="m-modal-header"><div class="m-modal-title">'+self._esc(title||'请输入')+'</div><button class="m-modal-close" onclick="M._askResolve(null)">×</button></div>'+
          '<div class="m-form-section">'+(msgHtml?'<p style="font-size:0.8rem;color:var(--text2);">'+msgHtml+'</p>':'')+
          '<div class="m-field"><input id="m-ask-input" class="m-input" placeholder="'+self._esc(placeholder||'')+'"></div></div>'+
          '<div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M._askResolve(null)">取消</button><button class="m-btn m-btn-primary" onclick="M._askSubmit()">确认</button></div>');
        self._askCb = resolve;
        setTimeout(function(){ var el = document.getElementById('m-ask-input'); if (el) el.focus(); }, 80);
      });
    },
    _askSubmit() {
      var el = document.getElementById('m-ask-input');
      var v = el ? el.value : '';
      var cb = this._askCb; this._askCb = null;
      this.closeModal();
      if (cb) cb(v);
    },
    _askResolve(v) {
      var cb = this._askCb; this._askCb = null;
      this.closeModal();
      if (cb) cb(v);
    },

    _copyText: async function(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(text); return true; } catch(e) {}
      }
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch(e) { return false; }
    },

    async _renderSNLinks(wrap) {
      var self = this;
      var list = [];
      try { list = (await API.getSNRegistry()) || []; } catch(e) {}
      this._snlData = list;
      this._snlFilter = this._snlFilter || 'all';
      this._snlSearch = this._snlSearch || '';
      var counts = {all:list.length, available:0, in_use:0, in_repair:0, damaged:0, transferred:0};
      list.forEach(function(s){ if (counts[s.status] !== undefined) counts[s.status]++; });
      var chips = [['all','全部'],['available','库存'],['in_use','使用中'],['in_repair','售后中'],['damaged','已损坏'],['transferred','已转出']];
      wrap.innerHTML = '<div class="m-form-section">'+
        '<div class="m-stat-grid" style="margin:4px 0 10px;">'+S.stat('总数量',counts.all)+S.stat('库存',counts.available)+S.stat('使用中',counts.in_use)+S.stat('售后中',counts.in_repair)+'</div>'+
        '<div class="m-sub-tabs" style="margin-bottom:8px;flex-wrap:wrap;">'+chips.map(function(c){
          return '<button class="m-sub-tab'+(self._snlFilter===c[0]?' active':'')+'" onclick="M._snlSetFilter(\''+c[0]+'\')">'+c[1]+' ('+counts[c[0]]+')</button>';
        }).join('')+'</div>'+
        '<input id="m-snl-search" class="m-input" placeholder="搜索SN码/机器编号/手型..." value="'+self._esc(self._snlSearch)+'" oninput="M._snlSearchInput(this.value)">'+
        '<div id="m-snl-list" style="margin-top:10px;"></div>'+
        '<div class="m-btn-row"><button class="m-btn m-btn-outline m-btn-block" onclick="M._snlCopyAll()">📋 一键复制全部链接</button></div>'+
        '</div>';
      this._snlRenderList();
    },
    _snlSetFilter(f) { this._snlFilter = f; this.showAdminSubPage('sn-links', true); },
    _snlSearchInput(v) { this._snlSearch = v || ''; this._snlRenderList(); },
    _snlFiltered() {
      var f = this._snlFilter || 'all';
      var q = (this._snlSearch || '').trim().toLowerCase();
      return (this._snlData || []).filter(function(s){
        if (f !== 'all' && s.status !== f) return false;
        if (!q) return true;
        var sn = (s.snCode||s.sn||s.id||'')+'';
        var mn = (s.machineNumber||'')+'';
        var ht = (s.handType||'')+'';
        var et = (s.equipmentType||'')+'';
        return sn.toLowerCase().indexOf(q)>=0 || mn.toLowerCase().indexOf(q)>=0 || ht.toLowerCase().indexOf(q)>=0 || et.toLowerCase().indexOf(q)>=0;
      });
    },
    _snlUrl(sn) { return location.origin + '/sn-status.html?sn=' + encodeURIComponent(sn); },
    _snlOpen(sn) { location.href = this._snlUrl(sn); },
    _snlRenderList() {
      var wrap = document.getElementById('m-snl-list');
      if (!wrap) return;
      var self = this;
      var filtered = this._snlFiltered();
      if (!filtered.length) { wrap.innerHTML = '<div class="m-empty"><div class="m-empty-text">暂无匹配的 SN</div></div>'; return; }
      wrap.innerHTML = filtered.slice(0, 200).map(function(s){
        var sn = s.snCode || s.sn || s.id;
        var url = self._snlUrl(sn);
        var si = self._snSI(s.status);
        var handLabel = s.handType === 'left' ? '左手' : s.handType === 'right' ? '右手' : '设备';
        return '<div class="m-device-card">'+
          '<div class="m-device-header"><div class="m-device-name" style="font-family:monospace;">'+self._esc(sn)+'</div><span class="m-badge '+si.c+'">'+si.l+'</span></div>'+
          '<div class="m-device-info">'+handLabel+(s.equipmentType?' · '+self._esc(s.equipmentType):'')+(s.machineNumber?' · 绑定 '+self._esc(s.machineNumber):'')+'</div>'+
          '<div class="m-device-info" style="word-break:break-all;font-size:0.7rem;opacity:0.7;">'+self._esc(url)+'</div>'+
          '<div style="display:flex;gap:6px;margin-top:6px;">'+
            '<button class="m-btn m-btn-sm m-btn-outline" style="flex:1;" onclick="M._snlOpen(\''+self._esc(sn)+'\')">🔗 打开</button>'+
            '<button class="m-btn m-btn-sm m-btn-outline" style="flex:1;" onclick="M._snlCopy(\''+self._esc(sn)+'\')">复制</button>'+
          '</div></div>';
      }).join('') + (filtered.length > 200 ? '<div class="m-empty-text" style="text-align:center;padding:8px 0;font-size:0.75rem;opacity:0.6;">仅显示前 200 条，请用筛选或搜索缩小范围</div>' : '');
    },
    async _snlCopy(sn) {
      var ok = await this._copyText(this._snlUrl(sn));
      this.toast(ok ? '链接已复制' : '复制失败，请手动复制', ok ? 'ok' : 'err');
    },
    _snlCopyAll() {
      var self = this;
      var urls = this._snlFiltered().map(function(s){ return self._snlUrl(s.snCode || s.sn || s.id); });
      if (!urls.length) { this.toast('暂无链接可复制', 'err'); return; }
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">全部链接（'+urls.length+' 条）</div><button class="m-modal-close" onclick="M.closeModal()">×</button></div>'+
        '<div class="m-form-section"><textarea id="m-snl-all" class="m-input" rows="8" style="font-size:0.7rem;word-break:break-all;min-height:160px;" readonly>'+this._esc(urls.join('\n'))+'</textarea></div>'+
        '<div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">关闭</button><button class="m-btn m-btn-primary" onclick="M._snlCopyAllGo()">📋 复制全部</button></div>');
    },
    async _snlCopyAllGo() {
      var ta = document.getElementById('m-snl-all');
      if (!ta) return;
      var n = ta.value.split('\n').length;
      var ok = await this._copyText(ta.value);
      this.toast(ok ? '已复制 '+n+' 条链接' : '复制失败，请长按文本框手动全选复制', ok ? 'ok' : 'err');
    },

    async _renderMachineLinks(wrap) {
      var self = this;
      var machines = [], registry = [], eqcfg = [];
      try { machines = (await API.getMachines()) || []; } catch(e) {}
      try { registry = (await API.getSNRegistry()) || []; } catch(e) {}
      try { eqcfg = (await API.getEquipmentConfig()) || []; } catch(e) {}
      var typeLabel = {};
      (eqcfg||[]).forEach(function(c){ typeLabel[c.id] = (c.icon||'')+' '+c.name; });

      var byNum = {};
      (registry||[]).forEach(function(s){
        if (s.status !== 'in_use' && s.status !== 'inUse') return;
        var num = s.machineNumber;
        if (!num) return;
        if (!byNum[num]) byNum[num] = {left:null,right:null};
        if (s.handType === 'right') { if (!byNum[num].right) byNum[num].right = s; }
        else { if (!byNum[num].left) byNum[num].left = s; }
      });
      var nums = {};
      Object.keys(byNum).forEach(function(n){ nums[n] = 1; });
      (machines||[]).forEach(function(m){ if (m.machineNumber) nums[m.machineNumber] = 1; });
      var list = Object.keys(nums).map(function(num){
        var b = byNum[num] || {left:null,right:null};
        var st = (b.left && b.right) ? 'online' : (b.left || b.right) ? 'partial' : 'offline';
        var rec = null;
        (machines||[]).forEach(function(m){
          if (m.machineNumber === num && (!rec || String(m.timestamp||m.createdAt||'') > String(rec.timestamp||rec.createdAt||''))) rec = m;
        });
        return {num:num, status:st, deviceType: rec ? rec.deviceType : '', equipmentType: rec ? rec.equipmentType : ''};
      }).sort(function(a,b){ return a.num < b.num ? -1 : 1; });
      this._mldData = list;
      this._mldFilter = this._mldFilter || 'all';
      this._mldSearch = this._mldSearch || '';
      var counts = {all:list.length, online:0, partial:0, offline:0};
      list.forEach(function(x){ counts[x.status]++; });
      var chips = [['all','全部'],['online','在线'],['partial','部分绑定'],['offline','离线']];
      wrap.innerHTML = '<div class="m-form-section">'+
        '<div class="m-stat-grid" style="margin:4px 0 10px;">'+S.stat('机器总数',counts.all)+S.stat('在线',counts.online)+S.stat('部分绑定',counts.partial)+S.stat('离线',counts.offline)+'</div>'+
        '<div class="m-sub-tabs" style="margin-bottom:8px;flex-wrap:wrap;">'+chips.map(function(c){
          return '<button class="m-sub-tab'+(self._mldFilter===c[0]?' active':'')+'" onclick="M._mldSetFilter(\''+c[0]+'\')">'+c[1]+' ('+counts[c[0]]+')</button>';
        }).join('')+'</div>'+
        '<input id="m-mld-search" class="m-input" placeholder="搜索机器编号..." value="'+self._esc(self._mldSearch)+'" oninput="M._mldSearchInput(this.value)">'+
        '<div id="m-mld-list" style="margin-top:10px;"></div>'+
        '<div class="m-btn-row"><button class="m-btn m-btn-outline m-btn-block" onclick="M._mldCopyAll()">📋 一键复制全部链接</button></div>'+
        '</div>';
      this._mldRenderList(typeLabel);
    },
    _mldSetFilter(f) { this._mldFilter = f; this.showAdminSubPage('machine-links', true); },
    _mldSearchInput(v) { this._mldSearch = v || ''; var self = this; var eqcfg = []; try { eqcfg = this._mldEqLabels || []; } catch(e) {} this._mldRenderList(this._mldEqLabels || {}); },
    _mldUrl(num) { return location.origin + '/machine-status.html?code=' + encodeURIComponent(num); },
    _mldOpen(num) { location.href = this._mldUrl(num); },
    _mldRenderList(typeLabel) {
      this._mldEqLabels = typeLabel || {};
      var wrap = document.getElementById('m-mld-list');
      if (!wrap) return;
      var self = this;
      var f = this._mldFilter || 'all';
      var q = (this._mldSearch || '').trim().toLowerCase();
      var filtered = (this._mldData || []).filter(function(x){
        if (f !== 'all' && x.status !== f) return false;
        if (!q) return true;
        return (x.num+'').toLowerCase().indexOf(q) >= 0;
      });
      if (!filtered.length) { wrap.innerHTML = '<div class="m-empty"><div class="m-empty-text">暂无机器，添加机器后在此生成状态链接</div></div>'; return; }
      wrap.innerHTML = filtered.slice(0, 200).map(function(x){
        var url = self._mldUrl(x.num);
        var si = self._machineSI(x.status);
        return '<div class="m-device-card">'+
          '<div class="m-device-header"><div class="m-device-name" style="font-family:monospace;">'+self._esc(x.num)+'</div><span class="m-badge '+si.c+'">'+si.l+'</span></div>'+
          '<div class="m-device-info">'+self._esc(typeLabel[x.deviceType] || x.equipmentType || '设备')+'</div>'+
          '<div class="m-device-info" style="word-break:break-all;font-size:0.7rem;opacity:0.7;">'+self._esc(url)+'</div>'+
          '<div style="display:flex;gap:6px;margin-top:6px;">'+
            '<button class="m-btn m-btn-sm m-btn-outline" style="flex:1;" onclick="M._mldOpen(\''+self._esc(x.num)+'\')">🔗 打开</button>'+
            '<button class="m-btn m-btn-sm m-btn-outline" style="flex:1;" onclick="M._mldCopy(\''+self._esc(x.num)+'\')">复制</button>'+
          '</div></div>';
      }).join('') + (filtered.length > 200 ? '<div class="m-empty-text" style="text-align:center;padding:8px 0;font-size:0.75rem;opacity:0.6;">仅显示前 200 条，请用筛选或搜索缩小范围</div>' : '');
    },
    async _mldCopy(num) {
      var ok = await this._copyText(this._mldUrl(num));
      this.toast(ok ? '链接已复制' : '复制失败，请手动复制', ok ? 'ok' : 'err');
    },
    _mldCopyAll() {
      var self = this;
      var f = this._mldFilter || 'all';
      var q = (this._mldSearch || '').trim().toLowerCase();
      var urls = (this._mldData || []).filter(function(x){
        if (f !== 'all' && x.status !== f) return false;
        if (!q) return true;
        return (x.num+'').toLowerCase().indexOf(q) >= 0;
      }).map(function(x){ return self._mldUrl(x.num); });
      if (!urls.length) { this.toast('暂无链接可复制', 'err'); return; }
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">全部链接（'+urls.length+' 条）</div><button class="m-modal-close" onclick="M.closeModal()">×</button></div>'+
        '<div class="m-form-section"><textarea id="m-mld-all" class="m-input" rows="8" style="font-size:0.7rem;word-break:break-all;min-height:160px;" readonly>'+this._esc(urls.join('\n'))+'</textarea></div>'+
        '<div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">关闭</button><button class="m-btn m-btn-primary" onclick="M._mldCopyAllGo()">📋 复制全部</button></div>');
    },
    async _mldCopyAllGo() {
      var ta = document.getElementById('m-mld-all');
      if (!ta) return;
      var n = ta.value.split('\n').length;
      var ok = await this._copyText(ta.value);
      this.toast(ok ? '已复制 '+n+' 条链接' : '复制失败，请长按文本框手动全选复制', ok ? 'ok' : 'err');
    },

    async _renderEquipmentConfig(wrap) {
      var cfg = [], inv = [];
      try { cfg = (await API.getEquipmentConfig()) || []; } catch(e) {}
      try { inv = (await API.getInventoryConfig()) || []; } catch(e) {}
      this._eqcfgData = cfg;
      this._eqcfgInv = inv;
      wrap.innerHTML = '<div class="m-form-section">'+
        '<div class="m-section-title">设备类型定义机器上/下线时自动消耗和归还的库存物品，修改后仅对新记录生效。</div>'+
        '<div class="m-btn-row"><button class="m-btn m-btn-primary m-btn-block" onclick="M._eqcfgForm(null)">+ 添加设备类型</button></div>'+
        '<div id="m-eqcfg-list" style="margin-top:10px;"></div></div>';
      this._eqcfgRenderList();
    },
    _eqcfgRenderList() {
      var wrap = document.getElementById('m-eqcfg-list');
      if (!wrap) return;
      var self = this;
      var cfg = this._eqcfgData || [];
      var inv = this._eqcfgInv || [];
      if (!cfg.length) { wrap.innerHTML = '<div class="m-empty"><div class="m-empty-text">暂无设备类型，点击上方按钮添加</div></div>'; return; }
      var invLabel = {};
      inv.forEach(function(c){ invLabel[c.id] = (c.icon||'')+' '+c.name; });
      wrap.innerHTML = cfg.map(function(c){
        var cons = (c.consumes||[]).map(function(i){
          return self._esc(invLabel[i.inventoryType] || i.inventoryType) + (i.handType === 'left' ? '(左手)' : i.handType === 'right' ? '(右手)' : '') + ' × ' + (i.quantity||1);
        }).join('、') || '-';
        return '<div class="m-device-card">'+
          '<div class="m-device-header"><div class="m-device-name">'+self._esc(c.icon||'')+' '+self._esc(c.name)+'</div></div>'+
          '<div class="m-device-info">消耗：'+cons+'</div>'+
          '<div style="display:flex;gap:6px;margin-top:6px;">'+
            '<button class="m-btn m-btn-sm m-btn-outline" style="flex:1;" onclick="M._eqcfgForm(\''+self._esc(c.id)+'\')">编辑</button>'+
            '<button class="m-btn m-btn-sm m-btn-outline" style="flex:1;color:#ef4444;border-color:#ef4444;" onclick="M._eqcfgDelete(\''+self._esc(c.id)+'\')">删除</button>'+
          '</div></div>';
      }).join('');
    },
    _eqcfgForm(id) {
      var self = this;
      var cfg = this._eqcfgData || [];
      var editing = id ? cfg.find(function(c){ return c.id === id; }) : null;
      this._eqcfgRows = editing ? (editing.consumes||[]).map(function(r){ return {inventoryType:r.inventoryType||'', handType:r.handType||'', quantity:Number(r.quantity)||1}; }) : [];
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">'+(editing?'编辑设备类型':'添加设备类型')+'</div><button class="m-modal-close" onclick="M.closeModal()">×</button></div>'+
        '<div class="m-form-section">'+
        '<div class="m-field"><label class="m-field-label">设备名称 *</label><input id="m-eqcfg-name" class="m-input" placeholder="如：纯手套设备" value="'+self._esc(editing?editing.name:'')+'"></div>'+
        '<div class="m-field"><label class="m-field-label">图标（表情符号）</label><input id="m-eqcfg-icon" class="m-input" placeholder="如 🤖" value="'+self._esc(editing?(editing.icon||''):'')+'"></div>'+
        '<div class="m-field"><label class="m-field-label">消耗库存物品（上/下线时自动扣减/归还）</label>'+
        '<div id="m-eqcfg-rows"></div>'+
        '<button class="m-btn m-btn-sm m-btn-outline" style="margin-top:6px;" onclick="M._eqcfgAddRow()">+ 添加消耗项</button></div>'+
        '</div><div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">取消</button><button class="m-btn m-btn-primary" onclick="M._eqcfgSave('+(editing?'\''+self._esc(editing.id)+'\'':'null')+')">保存</button></div>');
      var box = document.getElementById('m-eqcfg-rows');
      var self2 = this;
      if (box) box.innerHTML = this._eqcfgRows.map(function(r, i){ return self2._eqcfgRowHtml(i, r); }).join('');
    },
    _eqcfgRowHtml(idx, r) {
      var self = this;
      var inv = this._eqcfgInv || [];
      var opts = '<option value="">-- 库存类型 --</option>' + inv.map(function(c){
        return '<option value="'+self._esc(c.id)+'"'+(r.inventoryType===c.id?' selected':'')+'>'+self._esc((c.icon||'')+' '+c.name)+'</option>';
      }).join('');
      var hand = r.handType || '';
      return '<div style="display:flex;gap:6px;margin-bottom:6px;align-items:center;">'+
        '<select class="m-select" style="flex:2;min-width:0;" onchange="M._eqcfgRowSet('+idx+',\'inventoryType\',this.value)">'+opts+'</select>'+
        '<select class="m-select" style="width:74px;flex:none;" onchange="M._eqcfgRowSet('+idx+',\'handType\',this.value)">'+
          '<option value=""'+(hand===''?' selected':'')+'>不区分</option>'+
          '<option value="left"'+(hand==='left'?' selected':'')+'>左手</option>'+
          '<option value="right"'+(hand==='right'?' selected':'')+'>右手</option></select>'+
        '<input type="number" min="1" class="m-input" style="width:56px;flex:none;padding:6px 4px;" value="'+(Number(r.quantity)||1)+'" onchange="M._eqcfgRowSet('+idx+',\'quantity\',this.value)">'+
        '<button class="m-btn m-btn-sm m-btn-outline" style="flex:none;color:#ef4444;border-color:#ef4444;padding:6px 10px;" onclick="M._eqcfgDelRow('+idx+')">✕</button></div>';
    },
    _eqcfgRowSet(idx, key, val) {
      var rows = this._eqcfgRows = this._eqcfgRows || [];
      if (!rows[idx]) rows[idx] = {inventoryType:'', handType:'', quantity:1};
      rows[idx][key] = key === 'quantity' ? (parseInt(val, 10) || 1) : val;
    },
    _eqcfgAddRow() {
      this._eqcfgRows = this._eqcfgRows || [];
      var r = {inventoryType:'', handType:'', quantity:1};
      this._eqcfgRows.push(r);
      var box = document.getElementById('m-eqcfg-rows');
      if (box) box.insertAdjacentHTML('beforeend', this._eqcfgRowHtml(this._eqcfgRows.length-1, r));
    },
    _eqcfgDelRow(idx) {
      var self = this;
      this._eqcfgRows = (this._eqcfgRows||[]).filter(function(_, i){ return i !== idx; });
      var box = document.getElementById('m-eqcfg-rows');
      if (box) box.innerHTML = this._eqcfgRows.map(function(r, i){ return self._eqcfgRowHtml(i, r); }).join('');
    },
    async _eqcfgSave(id) {
      var name = ((document.getElementById('m-eqcfg-name')||{}).value||'').trim();
      var icon = ((document.getElementById('m-eqcfg-icon')||{}).value||'').trim();
      if (!name) { this.toast('请输入设备名称', 'err'); return; }
      var consumes = (this._eqcfgRows||[]).filter(function(r){ return r && r.inventoryType; })
        .map(function(r){ return {inventoryType:r.inventoryType, handType:r.handType||null, quantity:Number(r.quantity)||1}; });
      var isEdit = !!id;
      var old = isEdit ? (this._eqcfgData||[]).find(function(c){ return c.id === id; }) : null;
      var item = { id: isEdit ? id : ('eq-'+Date.now().toString(36)), name:name, icon:icon, consumes:consumes, createdAt: old ? old.createdAt : new Date().toISOString() };
      var all = isEdit ? (this._eqcfgData||[]).map(function(c){ return c.id === id ? item : c; }) : (this._eqcfgData||[]).concat([item]);
      try {
        await API.saveEquipmentConfig(all);
        this.closeModal();
        this.toast(isEdit ? '设备类型已更新' : '设备类型已添加', 'ok');
        this.showAdminSubPage('equipment-config');
      } catch(e) { this.toast('保存失败：'+((e&&e.message)||'网络错误'), 'err'); }
    },
    async _eqcfgDelete(id) {
      var item = (this._eqcfgData||[]).find(function(c){ return c.id === id; });
      var go = await this._askConfirm('确定删除设备类型 <b>'+this._esc(item?item.name:id)+'</b> 吗？已存在的机器记录不受影响。', '删除设备类型');
      if (!go) return;
      try {
        try { await API.deleteEquipmentConfig(id); }
        catch(e) { await API.saveEquipmentConfig((this._eqcfgData||[]).filter(function(c){ return c.id !== id; })); }
        this.toast('设备类型已删除', 'ok');
        this.showAdminSubPage('equipment-config');
      } catch(e) { this.toast('删除失败：'+((e&&e.message)||'网络错误'), 'err'); }
    },

    async _renderMachinesPage(wrap) {
      var self = this;
      var machines = [], registry = [], eqcfg = [], invcfg = [];
      try { machines = (await API.getMachines()) || []; } catch(e) {}
      try { registry = (await API.getSNRegistry()) || []; } catch(e) {}
      try { eqcfg = (await API.getEquipmentConfig()) || []; } catch(e) {}
      try { invcfg = (await API.getInventoryConfig()) || []; } catch(e) {}
      this._machData = {machines:machines, registry:registry, eqcfg:eqcfg, invcfg:invcfg};
      var nums = {};

      var presence = {};
      machines.forEach(function(m){
        if (m.machineNumber) nums[m.machineNumber] = 1;
        if (m.machineNumber && (m.hostOnline !== undefined || m.observedGloves || (m.edgeAlerts && m.edgeAlerts.length))) {
          presence[m.machineNumber] = m;
          nums[m.machineNumber] = 1;
        }
      });
      registry.forEach(function(s){ if ((s.status==='in_use'||s.status==='inUse') && s.machineNumber) nums[s.machineNumber] = 1; });
      var typeLabel = {};
      eqcfg.forEach(function(c){ typeLabel[c.id] = (c.icon||'')+' '+c.name; });
      var cards = Object.keys(nums).sort().map(function(num){
        var bound = registry.filter(function(s){ return s.machineNumber === num && (s.status==='in_use'||s.status==='inUse'); });
        var left = bound.find(function(s){ return s.handType === 'left'; }) || null;
        var right = bound.find(function(s){ return s.handType === 'right'; }) || null;
        var st = (left && right) ? 'online' : (left || right) ? 'partial' : 'offline';
        var rec = null;
        machines.forEach(function(m){
          if (m.machineNumber === num && (!rec || String(m.timestamp||m.createdAt||'') > String(rec.timestamp||rec.createdAt||''))) rec = m;
        });
        var si = self._machineSI(st);
        var p = presence[num] || null;
        var hostOnline = !!(p && p.hostOnline);
        var hasAgent = !!p;

        var hostLine;
        if (!hasAgent) {
          hostLine = '<div class="m-device-info" style="opacity:.55;">主机：未安装监控代理</div>';
        } else if (hostOnline) {
          hostLine = '<div class="m-device-info">主机：<span style="color:#52c41a;">🟢 在线</span>'+(p.hostIp ? ' · '+self._esc(p.hostIp) : '')+'</div>';
        } else {
          hostLine = '<div class="m-device-info">主机：<span style="color:#999;">⚫ 离线</span>'+(p.hostLastSeen ? ' · 最后在线 '+self._fmtTime(p.hostLastSeen) : '')+'</div>';
        }

        var obs = (p && p.observedGloves) || null;
        function obsHand(hand, boundSN) {
          var o = obs && obs[hand];
          var label = hand === 'left' ? '左手' : '右手';
          if (!o) return '<span style="opacity:.45;">'+label+' 未探测</span>';
          if (!o.connected) return '<span style="color:#ff4d4f;">'+label+' ❌未连接</span>';
          if (o.snCode) {
            var mismatch = boundSN && boundSN !== o.snCode;
            return '<span style="color:#52c41a;">'+label+' ✅ '+self._esc(o.snCode)+'</span>'
              +(mismatch ? '<span style="opacity:.45;"> (SN记录不同)</span>' : '');
          }
          return '<span style="color:#52c41a;">'+label+' ✅已连接</span><span style="opacity:.45;">(SN未识别)</span>';
        }
        var obsLine = obs ? '<div class="m-device-info" style="font-size:12px;">实测：'+obsHand('left', left && left.snCode)+' · '+obsHand('right', right && right.snCode)+'</div>' : '';

        var PS_META = {
          ready: { l: '可生产', c: '#389e0d', bg: '#f6ffed' },
          in_production: { l: '在生产', c: '#0958d9', bg: '#e6f4ff' },
          waiting_repair: { l: '待维修', c: '#cf1322', bg: '#fff1f0' },
          testing: { l: '在测试', c: '#d46b08', bg: '#fff7e6' },
        };
        var psKey = (rec && rec.productionStatus) || 'ready';
        var psMeta = PS_META[psKey] || PS_META.ready;
        var prodLine = '<div class="m-device-info">生产：<span style="display:inline-block;padding:1px 8px;border-radius:10px;background:'+psMeta.bg+';color:'+psMeta.c+';font-weight:600;">'+psMeta.l+'</span>'+
          ((rec && rec.productionReason) ? ' <span style="opacity:.6;font-size:12px;">'+self._esc(rec.productionReason)+'</span>' : '')+'</div>';

        var alertsHtml = '';
        if (p && p.collectorStarted !== false && p.edgeAlerts && p.edgeAlerts.length) {
          alertsHtml = p.edgeAlerts.map(function(a){
            if (self._isSNAdvisory(a)) {
              return '<div style="margin-top:4px;font-size:12px;color:#7d8da0;">ℹ '+self._esc(a.message)+'</div>';
            }
            var color = a.level === 'error' ? '#ff4d4f' : a.level === 'warn' ? '#fa8c16' : '#1677ff';
            return '<div style="margin-top:4px;font-size:12px;color:'+color+';">⚠ '+self._esc(a.message)+'</div>';
          }).join('');
        }
        return '<div class="m-device-card">'+
          '<div class="m-device-header"><div class="m-device-name" style="font-family:monospace;">'+self._esc(num)+(hasAgent ? ' <span style="font-size:12px;">'+(hostOnline ? '🟢' : '⚫')+'</span>' : '')+'</div><span class="m-badge '+si.c+'">'+si.l+'</span></div>'+
          '<div class="m-device-info">'+self._esc(typeLabel[rec ? rec.deviceType : ''] || (rec ? rec.equipmentType : '') || '设备')+'</div>'+
          prodLine+
          hostLine+
          '<div class="m-device-info">绑定：左手 '+self._esc(left ? left.snCode : '未绑定')+' · 右手 '+self._esc(right ? right.snCode : '未绑定')+'</div>'+
          obsLine+
          alertsHtml+
          '<div style="display:flex;gap:6px;margin-top:6px;">'+
          (st === 'online'
            ? '<button class="m-btn m-btn-sm m-btn-outline" style="flex:1;" onclick="M._machOffline(\''+self._esc(num)+'\')">下线</button>'
            : '<button class="m-btn m-btn-sm m-btn-primary" style="flex:1;" onclick="M._machOnline(\''+self._esc(num)+'\')">上线</button>')+
          '</div></div>';
      }).join('');
      wrap.innerHTML = '<div class="m-form-section">'+
        '<div class="m-btn-row"><button class="m-btn m-btn-primary m-btn-block" onclick="M._machOnline(\'\')">+ 新机器上线</button></div>'+
        '<div style="margin-top:10px;">'+(cards || '<div class="m-empty"><div class="m-empty-text">暂无机器</div></div>')+'</div></div>';
    },

    async _renderMachineStatusPage(wrap) {
      var self = this;
      var machines = [], eqcfg = [], history = [];
      try { machines = (await API.getMachines()) || []; } catch(e) {}
      try { eqcfg = (await API.getEquipmentConfig()) || []; } catch(e) {}
      try { history = (await API.getProductionHistory()) || []; } catch(e) {}

      var latestMap = {};
      machines.forEach(function(m){
        var num = m.machineNumber;
        if (!num) return;
        if (!latestMap[num] || String(m.timestamp||m.createdAt||'') > String(latestMap[num].timestamp||latestMap[num].createdAt||'')) {
          latestMap[num] = m;
        }
      });
      var numbers = Object.keys(latestMap).sort();

      var typeLabel = {};
      (eqcfg||[]).forEach(function(c){ if (c && c.id) typeLabel[c.id] = (c.icon||'')+' '+c.name; });
      var dtLabel = function(dt){ return typeLabel[dt] || dt || '-'; };
      var effectiveDeviceType = function(rec) {
        var mt = String(rec && rec.machineType || '').toLowerCase();
        return mt === 'dexterous' ? 'dexterous' : (mt === 'glove_only' ? 'glove' : ((rec && rec.deviceType) || ''));
      };

      var PS_META = {
        ready: { l: '可生产', c: '#389e0d', bg: '#f6ffed' },
        in_production: { l: '在生产', c: '#0958d9', bg: '#e6f4ff' },
        waiting_repair: { l: '待维修', c: '#cf1322', bg: '#fff1f0' },
        testing: { l: '在测试', c: '#d46b08', bg: '#fff7e6' },
      };
      var PS_ORDER = ['ready','in_production','waiting_repair','testing'];
      var psOf = function(rec){ return (rec && rec.productionStatus) || 'ready'; };

      var counts = { ready:0, in_production:0, waiting_repair:0, testing:0 };
      numbers.forEach(function(n){ counts[psOf(latestMap[n])] = (counts[psOf(latestMap[n])]||0)+1; });

      var dtSeen = {}, dtOptions = [{val:'all',label:'全部设备类型'}];
      numbers.forEach(function(n){
        var dt = effectiveDeviceType(latestMap[n]);
        if (dt && !dtSeen[dt]) { dtSeen[dt]=1; dtOptions.push({val:dt,label:dtLabel(dt)}); }
      });
      this._msData = { latestMap:latestMap, numbers:numbers, history:history, PS_META:PS_META, PS_ORDER:PS_ORDER, dtLabel:dtLabel, dtOptions:dtOptions, effectiveDeviceType:effectiveDeviceType };

      if (this._msProdFilter === undefined) this._msProdFilter = 'all';
      if (this._msDeviceType === undefined) this._msDeviceType = 'all';
      if (this._msSearch === undefined) this._msSearch = '';
      var dtSelOpts = dtOptions.map(function(o){
        return '<option value="'+self._esc(o.val)+'"'+(self._msDeviceType===o.val?' selected':'')+'>'+self._esc(o.label)+'</option>';
      }).join('');
      wrap.innerHTML = '<div class="m-form-section">'+
        '<div class="m-section-title">生产状态可视化：可生产 / 在生产 / 待维修 / 在测试（待维修由维修工单自动驱动）</div>'+
        '<div id="m-ms-stats"></div>'+
        '<div id="m-ms-prodtabs" style="margin:8px 0;"></div>'+
        '<div style="display:flex;gap:8px;margin-bottom:8px;">'+
          '<select class="m-select" style="flex:1;" onchange="M._msSetDt(this.value)">'+dtSelOpts+'</select>'+
          '<input class="m-input" style="flex:1;" placeholder="搜索机器编号..." value="'+this._esc(this._msSearch)+'" oninput="M._msSetSearch(this.value)">'+
        '</div>'+
        '<div id="m-ms-list"></div>'+
        '<div class="m-section-title" style="margin-top:16px;">生产状态变更记录</div>'+
        '<div id="m-ms-history"></div>'+
        '</div>';
      this._msRenderStats();
      this._msRenderList();
      this._msRenderHistory();
    },
    _msSetProd(v) { this._msProdFilter = v; this._msRenderList(); },
    _msSetDt(v) { this._msDeviceType = v; this._msRenderStats(); this._msRenderList(); },
    _msSetSearch(v) { this._msSearch = v; this._msRenderList(); },
    _msDeviceFiltered() {
      var D = this._msData;
      if (this._msDeviceType === 'all') return D.numbers.slice();
      return D.numbers.filter(function(n){ return D.effectiveDeviceType(D.latestMap[n]) === self._msDeviceType; });
    },
    _msRenderStats() {
      var self = this;
      var D = this._msData; if (!D) return;
      var PS_META = D.PS_META, PS_ORDER = D.PS_ORDER;

      var filtered = D.numbers.filter(function(n){
        if (self._msDeviceType === 'all') return true;
        return D.effectiveDeviceType(D.latestMap[n]) === self._msDeviceType;
      });

      var counts = { ready:0, in_production:0, waiting_repair:0, testing:0 };
      filtered.forEach(function(n){ var ps = (D.latestMap[n].productionStatus)||'ready'; counts[ps] = (counts[ps]||0)+1; });
      var totalLabel = this._msDeviceType === 'all' ? '机器总数' : (D.dtLabel(this._msDeviceType)+' 数量');

      var statsBox = document.getElementById('m-ms-stats');
      if (statsBox) {
        statsBox.innerHTML = '<div class="m-stat-row" style="display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;">'+
          '<div class="m-stat-card" style="flex:0 0 auto;min-width:80px;"><div class="m-stat-value">'+filtered.length+'</div><div class="m-stat-label">'+self._esc(totalLabel)+'</div></div>'+
          PS_ORDER.map(function(s){
            var meta = PS_META[s];
            return '<div class="m-stat-card" style="flex:0 0 auto;min-width:80px;"><div class="m-stat-value" style="color:'+meta.c+';">'+(counts[s]||0)+'</div><div class="m-stat-label">'+meta.l+'</div></div>';
          }).join('')+
          '</div>';
      }

      var tabsBox = document.getElementById('m-ms-prodtabs');
      if (tabsBox) {
        tabsBox.innerHTML = '<div class="m-sub-tabs" style="display:flex;flex-wrap:wrap;">'+
          '<button class="m-sub-tab'+(this._msProdFilter==='all'?' active':'')+'" onclick="M._msSetProd(\'all\')">全部('+filtered.length+')</button>'+
          PS_ORDER.map(function(s){
            return '<button class="m-sub-tab'+(self._msProdFilter===s?' active':'')+'" onclick="M._msSetProd(\''+s+'\')">'+PS_META[s].l+'('+(counts[s]||0)+')</button>';
          }).join('')+
          '</div>';
      }
    },
    _msRenderList() {
      var self = this;
      var D = this._msData; if (!D) return;
      var box = document.getElementById('m-ms-list'); if (!box) return;
      var PS_META = D.PS_META, PS_ORDER = D.PS_ORDER;
      var list = D.numbers.slice();
      if (this._msProdFilter !== 'all') list = list.filter(function(n){ return ((D.latestMap[n].productionStatus)||'ready') === self._msProdFilter; });
      if (this._msDeviceType !== 'all') list = list.filter(function(n){ return D.effectiveDeviceType(D.latestMap[n]) === self._msDeviceType; });
      var q = (this._msSearch||'').trim().toLowerCase();
      if (q) list = list.filter(function(n){ return n.toLowerCase().indexOf(q) >= 0; });
      if (!list.length) { box.innerHTML = '<div class="m-empty"><div class="m-empty-text">暂无符合条件的机器</div></div>'; return; }
      var cards = list.map(function(num){
        var rec = D.latestMap[num];
        var psKey = (rec && rec.productionStatus) || 'ready';
        var meta = PS_META[psKey] || PS_META.ready;
        var reason = rec.productionReason ? '<div class="m-device-info" style="opacity:.7;font-size:12px;">原因：'+self._esc(rec.productionReason)+'</div>' : '';
        var updater = rec.productionUpdatedByName || (rec.productionSource==='ticket'?'工单联动':'-');
        var updTime = rec.productionUpdatedAt ? self._fmtTime(rec.productionUpdatedAt) : '-';

        var switchBtn = '';
        if (psKey !== 'waiting_repair') {
          var otherOpts = PS_ORDER.filter(function(s){ return s !== 'waiting_repair' && s !== psKey; }).map(function(s){
            return '<option value="'+s+'">标记为「'+PS_META[s].l+'」</option>';
          }).join('');
          switchBtn = '<div style="display:flex;gap:6px;margin-top:6px;" onclick="event.stopPropagation()">'+
            '<select class="m-select" id="m-ms-sel-'+self._esc(num)+'" style="flex:1;">'+otherOpts+'</select>'+
            '<button class="m-btn m-btn-sm m-btn-primary" onclick="M._msDoSwitch(\''+self._esc(num)+'\')">变更</button>'+
            '</div>';
        } else {
          switchBtn = '<div style="margin-top:6px;font-size:12px;color:#cf1322;" onclick="event.stopPropagation()">待维修由维修工单驱动，工单完成后自动恢复可生产</div>';
        }

        var infoBtn = (/^(?:we|szx3)-\d+$/.test(num)) ?
          '<button class="m-btn m-btn-sm" style="margin-top:6px;width:100%;" onclick="event.stopPropagation();M._msShowCollectorInfo(\''+self._esc(num)+'\')">📡 采集器状态</button>' : '';
        var reportBtn = '<button class="m-btn m-btn-sm" style="margin-top:6px;width:100%;" onclick="event.stopPropagation();M._msShowTimeline(\''+self._esc(num)+'\')">📊 今日状态日报</button>';
        return '<div class="m-device-card" onclick="M._msShowMachineHistory(\''+self._esc(num)+'\')" style="cursor:pointer;">'+
          '<div class="m-device-header"><div class="m-device-name" style="font-family:monospace;">'+self._esc(num)+'</div>'+
            '<span style="display:inline-block;padding:1px 8px;border-radius:10px;background:'+meta.bg+';color:'+meta.c+';font-weight:600;">'+meta.l+'</span></div>'+
          '<div class="m-device-info">设备类型：'+self._esc(D.dtLabel(D.effectiveDeviceType(rec)))+'</div>'+ 
          reason+
          '<div class="m-device-info" style="font-size:12px;opacity:.7;">更新人：'+self._esc(updater)+' · '+updTime+'</div>'+
          '<div class="m-device-info" style="font-size:11px;color:#1677ff;">点击查看完整历史 →</div>'+
          switchBtn+
          reportBtn+
          infoBtn+
          '</div>';
      }).join('');
      box.innerHTML = cards;
    },

    async _msShowTimeline(num, date) {
      var self = this;
      var day = date || new Date().toISOString().slice(0, 10);
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">'+self._esc(num)+' · 每日状态日报</div><button class="m-modal-close" onclick="M.closeModal()">×</button></div><div id="m-ms-timeline-body" class="m-form-section"><div class="m-empty"><div class="m-empty-text">正在加载状态日报...</div></div></div>');
      try {
        var d = await API.getMachineStatusTimeline(num, day);
        var meta = d.statusMeta || {};
        var fmtDur = function(sec){ sec=Math.max(0,Math.round(Number(sec)||0)); if(sec<60)return sec+'秒'; var h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60); return h?h+'小时'+m+'分':m+'分'; };
        var rows = (d.intervals || []).map(function(r){ var m=meta[r.status]||{label:r.label||r.status,color:'#999'}; return '<div class="m-data-row"><div class="m-card-row"><div><div class="m-data-value" style="color:'+m.color+';">'+self._esc(m.label)+'</div><div class="m-data-label">'+self._fmtTime(r.startedAt)+' - '+(r.endedAt?self._fmtTime(r.endedAt):'当前')+'</div></div><div style="font-size:12px;">'+fmtDur(r.durationSec)+'</div></div></div>'; }).join('');
        var prodRows = (d.productionIntervals || []).map(function(r){ var m=meta[r.status]||{label:r.label||r.status,color:'#999'}; return '<div class="m-data-row"><div class="m-card-row"><div><div class="m-data-value" style="color:'+m.color+';">'+self._esc(m.label)+'</div><div class="m-data-label">'+self._fmtTime(r.startedAt)+' - '+(r.endedAt?self._fmtTime(r.endedAt):'当前')+'</div></div><div style="font-size:12px;">'+fmtDur(r.durationSec)+'</div></div></div>'; }).join('');
        var summary = Object.keys(d.summary||{}).map(function(k){ return '<span style="display:inline-block;margin:0 6px 6px 0;padding:4px 8px;background:#f5f5f5;border-radius:6px;">'+self._esc((d.summary[k]||{}).label||k)+'：'+fmtDur((d.summary[k]||{}).seconds)+'</span>'; }).join('') || '<span style="opacity:.5;">暂无运行状态记录</span>';
        var el = document.getElementById('m-ms-timeline-body');
        if (el) el.innerHTML = '<div style="margin-bottom:10px;"><input type="date" class="m-input" value="'+self._esc(day)+'" onchange="M._msShowTimeline(\''+self._esc(num)+'\',this.value)"></div><div style="margin-bottom:12px;">'+summary+'</div><div class="m-section-title">运行状态明细</div>'+(rows||'<div class="m-empty"><div class="m-empty-text">暂无运行状态记录</div></div>')+'<div class="m-section-title" style="margin-top:12px;">生产状态明细</div>'+(prodRows||'<div class="m-empty"><div class="m-empty-text">暂无生产状态记录</div></div>');
      } catch (e) {
        var err = document.getElementById('m-ms-timeline-body');
        if (err) err.innerHTML = '<div class="m-empty"><div class="m-empty-text">日报读取失败</div></div>';
      }
    },

    async _msShowCollectorInfo(num) {
      var self = this;
      if (this._msInfoTimer) { clearInterval(this._msInfoTimer); this._msInfoTimer = null; }
      if (this._msInfoCtrl) { try { this._msInfoCtrl.abort(); } catch (e) { } this._msInfoCtrl = null; }
      var devTag = function(d) {
        if (!d) return '<span style="opacity:.4;">无</span>';
        if (d.probeConnected === false) return '<span style="color:#cf1322;">未连接</span>';
        var age = d.ageS != null ? d.ageS : d.age_s;
        var seen = d.everSeen != null ? d.everSeen : d.ever_seen;
        if (d.status === 'connected') {
          if (seen === false) return '<span style="color:#d46b08;">已连接·无数据</span>';
          if (typeof age === 'number') {
            if (age <= 2) return '<span style="color:#389e0d;">实时 '+age+'s</span>';
            if (age <= 10) return '<span style="color:#d46b08;">延迟 '+age+'s</span>';
            return '<span style="color:#cf1322;">断流 '+age+'s</span>';
          }
          return '<span style="color:#389e0d;">已连接</span>';
        }
        return '<span style="color:#cf1322;">'+(d.status==='unknown'?'未知':'断开')+'</span>';
      };
      var camName = { ego_camera:'前置相机', wrist_left:'左手腕相机', wrist_right:'右手腕相机', vst_left:'头显左眼', vst_right:'头显右眼', overlay:'合成画面' };
      var CS = { RECORD:['录制中','#cf1322'], ACTIVE:['就绪','#389e0d'], ALIGN:['对齐中','#d46b08'], INIT:['准备中','#d46b08'], BOOT:['启动中','#d46b08'], STOPPED:['已停止','#999'] };
      var cell = function(label, valHtml, detail) {
        return '<div style="flex:1 1 30%;min-width:120px;background:#f7f8fa;border-radius:8px;padding:7px 9px;">'+
          '<div style="font-size:11px;opacity:.55;margin-bottom:2px;">'+label+'</div>'+
          '<div style="font-size:13px;">'+valHtml+'</div>'+
          (detail?'<div style="font-size:11px;opacity:.65;margin-top:3px;">'+detail+'</div>':'')+'</div>';
      };
      var netTag = function(d) {
        if (!d || d.connected === undefined) return '<span style="opacity:.4;">无</span>';
        return d.connected ? '<span style="color:#1677ff;">网络在线</span>' : '<span style="opacity:.6;">未响应探测</span>';
      };
      var tagFor = function(stream, net) { return stream ? devTag(stream) : netTag(net); };
      var netOff = function(x){ return x && x.connected === false ? '<span style="opacity:.6;">未响应探测</span>' : ''; };
      var delayTxt = function(v){ return v!=null ? '延迟 '+Math.round(Number(v))+'ms' : ''; };
      var render = function(d, errMsg) {
        var html = '';
        if (errMsg) {
          html = '<div class="m-empty"><div class="m-empty-text">'+self._esc(errMsg)+'</div></div>';
        } else if (!d || !d.success) {
          html = '<div class="m-empty"><div class="m-empty-text">'+self._esc((d && d.error) || '暂无数据')+'</div></div>';
        } else {
          var s = d.system || {}, dv = d.devices || {}, t = d.task;
          // 机器类型由心跳代理的实际探针结果决定。纯手套机即使历史快照中
          // 还残留灵巧手/机械臂字段，也不在状态面板渲染这些设备。
          var isGloveOnlyMachine = d.machineType === 'glove_only'
            || (d.machineProfile && d.machineProfile.machineType === 'glove_only');
          var hasDexterousMachine = !isGloveOnlyMachine;
          html += (d.partial && d.partial.importer ? '<div style="background:#fff7e6;border-radius:8px;padding:6px 10px;font-size:12px;color:#d46b08;margin-bottom:6px;">Importer(5025) 暂不可达</div>' : '');
          html += (d.partial && d.partial.hermesOffline ? '<div style="background:#fafafa;border:1px solid #f0f0f0;border-radius:8px;padding:6px 10px;font-size:12px;color:#8c8c8c;margin-bottom:6px;">采集程序未运行</div>' : '');
          html += (d.partial && d.partial.hermesFailed ? '<div style="background:#fff7e6;border-radius:8px;padding:6px 10px;font-size:12px;color:#d46b08;margin-bottom:6px;">采集程序(5006) 暂不可达</div>' : '');
          var stale = !!s.stateStale;
          var cs = stale ? ['已停止', '#999'] : (CS[s.controlState] || [s.controlState || '未知', '#999']);
          html += '<div class="m-form-section-title">系统程序</div>';
          html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">'+
            cell('机器类型', '<span style="font-weight:600;color:'+(isGloveOnlyMachine?'#666':'#1677ff')+';">'+(isGloveOnlyMachine?'纯手套机器':d.machineType==='dexterous'?'灵巧手机器':'未知')+'</span>')+
            cell('系统程序', '<span style="color:'+(s.activity==='running'?'#389e0d':'#999')+';font-weight:600;">'+(s.activity==='running'?'运行中':(s.activity==='idle'?'空闲':(s.activity||'未知')))+'</span>')+
            cell('工作阶段', '<span style="color:'+cs[1]+';font-weight:600;">'+cs[0]+'</span>'+(!stale&&s.isRecording?' <span style="color:#cf1322;">● 录制中</span>':'')+
              (stale&&s.lastControlState?' <span style="font-size:11px;opacity:.65;">停止前: '+((CS[s.lastControlState]||[s.lastControlState])[0])+(s.lastIsRecording?'·录制中':'')+(s.lastStateAgeSec?('（'+Math.round(s.lastStateAgeSec/60)+' 分钟前）'):'')+'</span>':''))+
            cell('程序版本', 'I '+(d.importerVersion||'-')+' / C '+(d.collectorVersion||'-'))+
            cell('错误数', (s.errorCount||0)>0?'<span style="color:#cf1322;font-weight:600;">'+s.errorCount+'</span>':'<span style="color:#389e0d;">0</span>')+
            cell('采集器', self._esc(d.collectorName||'-'))+
            cell('主机编号', self._esc(d.computerId||'-'))+
            '</div>';
          html += '<div class="m-form-section-title">当前任务</div>';
          if (t) {
            var pct = t.percent || 0;
            html += '<div style="margin-bottom:6px;"><b>'+self._esc(t.name||'-')+'</b>'+(t.isTraining?' <span style="color:#722ed1;">[培训]</span>':'')+
              ' <span style="opacity:.5;font-size:12px;">'+(t.state==='active'?'进行中':self._esc(t.state||''))+'</span></div>';
            html += '<div style="font-size:12px;opacity:.7;margin-bottom:4px;">采集员：'+self._esc((t.operator&&t.operator.name)||'未知')+(t.operator&&t.operator.level!=null?'（等级 '+t.operator.level+'）':'')+'</div>';
            html += '<div style="background:#f0f0f0;border-radius:6px;height:8px;overflow:hidden;"><div style="width:'+pct+'%;background:#1677ff;height:8px;"></div></div>';
            var hc = t.hoursCompleted!=null ? Number(t.hoursCompleted).toFixed(2) : '0';
            var hh = t.hours!=null ? Number(t.hours).toFixed(2) : '-';
            html += '<div style="font-size:12px;opacity:.7;margin-top:3px;">'+hc+' / '+hh+' 小时（'+pct+'%）</div>';
          } else {
            html += '<div style="opacity:.45;font-size:13px;margin-bottom:8px;">当前没有任务</div>';
          }
          html += '<div class="m-form-section-title" style="margin-top:10px;">设备状态</div>';
          var qi = d.questInfo || null, dnet = d.devicesNet || null, wuji = d.wuji || null;
          var diagFor = function(kind, side) {
            var net = dnet && dnet[kind] && dnet[kind][side];
            var sdk = wuji && wuji[kind] && wuji[kind][side];
            if (!net && !sdk) return null;
            net = net && typeof net === 'object' ? net : {};
            sdk = sdk && typeof sdk === 'object' ? sdk : {};
            return Object.assign({}, net, sdk, {
              snCode: sdk.sn || net.snCode || null,
              ip: sdk.ip || net.ip || null,
            });
          };
          var hasComponents = (hasDexterousMachine && !!(dv.dexterousHands && (dv.dexterousHands.left || dv.dexterousHands.right))) || !!dv.quest || !!(dv.gloves && (dv.gloves.left || dv.gloves.right)) || (dv.cameras||[]).length || (dv.other||[]).length || !!qi || !!dnet || !!wuji || !!d.cameraFps || (d.camerasFps||[]).length || (d.cameras||[]).length;
          if (!hasComponents) {
            html += '<div style="color:#8c8c8c;font-size:13px;padding:4px 0;">采集程序未运行</div>';
          } else {
            var handCell = function(side) {
              var stream = dv.dexterousHands && dv.dexterousHands[side];
              var net = diagFor('dexterousHands', side);
              var tag = tagFor(stream, net);
              var hs = d.handStream && d.handStream[side];
              var hsTxt = (hs && hs.ageSec != null && hs.ageSec <= 90 && hs.hz != null)
                ? '<span style="font-family:monospace;">'+hs.hz+' Hz'+(hs.target!=null?'/'+hs.target:'')+'</span>'
                  +(hs.lateTicks!=null&&hs.totalTicks!=null?' 迟到'+hs.lateTicks+'/'+hs.totalTicks:'')
                : '';
              var jointTxt = net && net.onlineJoints != null
                ? '<span style="font-family:monospace;">关节 '+self._esc(net.onlineJoints)+'/'+self._esc(net.expectedJoints||20)+'</span>' : '';
              var errTxt = net && net.error ? '<span style="color:#cf1322;">'+self._esc(net.error)+'</span>' : '';
              var detail = [net && net.snCode ? '<span style="font-family:monospace;">SN: '+self._esc(net.snCode)+'</span>' : '', jointTxt, delayTxt(d.teleopDelay && d.teleopDelay[side]), hsTxt, netOff(net), errTxt].filter(Boolean).join('　');
              return cell('灵巧手（'+(side==='left'?'左':'右')+'）', tag, detail);
            };
            var questCellHtml = (function(){
              var tag = tagFor(dv.quest, qi ? { connected: qi.netConnected } : null);
              var parts = [];
              if (qi && qi.serialNumber) parts.push('<span style="font-family:monospace;">SN: '+self._esc(qi.serialNumber)+'</span>');
              else if (qi && qi.adbStatus==='unauthorized') parts.push('<span style="color:#d46b08;">USB 调试未授权</span>');
              if (qi && qi.batteryLevel != null) parts.push('电量 '+qi.batteryLevel+'%'+(qi.batteryStatus==='charging'?'（充电中）':qi.batteryStatus==='full'?'（已充满）':'')+(qi.batteryTemp!=null?'　'+qi.batteryTemp+'℃':''));
              else if (qi && !qi.serialNumber && qi.netConnected===false) parts.push('<span style="color:#cf1322;">网络不可达</span>');
              return cell('Quest', tag, parts.join('　'));
            })();
            var gloveSn = function(side){
              var g = diagFor('gloves', side);
              if (!g) return '';
              var parts = ['<span style="font-family:monospace;">SN: '+self._esc(g.snCode||'未读取')+'</span>'];
              if (g.tactileOk != null || g.emfPosesOk != null) {
                parts.push('<span style="font-family:monospace;">触觉 '+(g.tactileOk?'✓':'×')+' · 姿态 '+(g.emfPosesOk?'✓':'×')+'</span>');
              }
              if (g.dataStreamOk != null) parts.push('<span style="font-family:monospace;">数据流 '+(g.dataStreamOk?'✓':'×')+'</span>');
              if (g.tactileFrames != null || g.emfPosesFrames != null) {
                parts.push('帧 '+(g.tactileFrames||0)+'/'+(g.emfPosesFrames||0));
              }
              if (g.error) parts.push('<span style="color:#cf1322;">'+self._esc(g.error)+'</span>');
              return parts.join('　');
            };
            var sensorRes = {};
            (d.sensors||[]).forEach(function(x){ if(x.id && x.width) sensorRes[x.id]=x.width+'×'+x.height; });
            var fpsCameras = (d.cameraFps && Array.isArray(d.cameraFps.cameras))
              ? d.cameraFps.cameras
              : (Array.isArray(d.camerasFps) ? d.camerasFps : (Array.isArray(d.cameras) ? d.cameras : []));
            var fpsForCamera = function(name) {
              var x = fpsCameras.find(function(item) {
                return item && (item.cameraId === name || item.name === name || item.device === name);
              });
              if (!x || !Number.isFinite(Number(x.currentFPS)) || Number(x.currentFPS) <= 0) return 'FPS 暂无';
              return Number(x.currentFPS).toFixed(1) + ' fps';
            };
            var cameraTag = function(c, fpsText) {
              if (c && (c.status === 'error' || c.connected === false)) return '<span style="color:#cf1322;">异常</span>';
              if (c && (c.status === 'dropping' || c.isDropping)) return '<span style="color:#d46b08;">掉帧</span>';
              return fpsText !== 'FPS 暂无' ? '<span style="color:#389e0d;">正常</span>' : '<span style="color:#8c8c8c;">无数据</span>';
            };
            html += '<div style="display:flex;flex-wrap:wrap;gap:6px;">'+
              (hasDexterousMachine ? handCell('left') : '')+
              (hasDexterousMachine ? handCell('right') : '')+
              questCellHtml+
              cell('手套（左）', tagFor(dv.gloves && dv.gloves.left, diagFor('gloves', 'left')), [gloveSn('left'), netOff(diagFor('gloves', 'left'))].filter(Boolean).join('　'))+
              cell('手套（右）', tagFor(dv.gloves && dv.gloves.right, diagFor('gloves', 'right')), [gloveSn('right'), netOff(diagFor('gloves', 'right'))].filter(Boolean).join('　'))+
              (hasDexterousMachine && (dv.marvin || (dnet && dnet.roboticArm))?cell('机械臂 Marvin', tagFor(dv.marvin, dnet && dnet.roboticArm ? { connected: dnet.roboticArm.connected } : null), netOff(dnet && dnet.roboticArm)):'')+
              ((dv.cameras && dv.cameras.length ? dv.cameras
                : (d.camerasFps && d.camerasFps.length ? d.camerasFps
                  : (d.cameras && d.cameras.length ? d.cameras
                    : (d.cameraFps && d.cameraFps.cameras || [])))).map(function(c){
                var fpsText = fpsForCamera(c.name);
                var fpsColor = fpsText !== 'FPS 暂无' ? '#389e0d' : '#8c8c8c';
                return cell(
                  camName[c.name]||c.name,
                  '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">'+cameraTag(c, fpsText)+'<span style="font-family:monospace;font-size:12px;color:'+fpsColor+';">'+fpsText+'</span></div>',
                  sensorRes[c.name]||''
                );
              }).join(''))+
              '</div>';
            var cf = d.cameraFps || null;
            var fpsParts = [];
            if (cf && cf.fps != null) {
              var a = cf.ageSec;
              var ageTxt = a == null ? '' : (a <= 60 ? '（录制中·实时）' : a < 3600 ? '（'+Math.round(a/60)+' 分钟前日志）' : '（'+Math.round(a/3600)+' 小时前日志）');
              fpsParts.push('三路平均 '+Number(cf.fps).toFixed(1)+' fps'+ageTxt);
            }
            if (d.vstFps) fpsParts.push('透视配置 '+d.vstFps+' fps');
            if (fpsParts.length) html += '<div style="font-size:11px;opacity:.65;margin-top:6px;">'+fpsParts.join(' · ')+'</div>';
          }
          html += '<div class="m-form-section-title" style="margin-top:10px;">采集器容器</div>';
          html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;">'+
            ((d.containers||[]).map(function(c){
              var ok = c.status==='running';
              return '<span style="padding:2px 8px;border-radius:10px;font-size:12px;background:'+(ok?'#f6ffed':'#fff1f0')+';color:'+(ok?'#389e0d':'#cf1322')+';">'+self._esc(c.name)+': '+(ok?'运行中':self._esc(c.status))+'</span>';
            }).join('') || '<span style="opacity:.4;">-</span>')+'</div>';
          if ((d.degraded||[]).length) html += '<div style="background:#fff7e6;border-radius:8px;padding:6px 10px;font-size:12px;color:#d46b08;">降级部件：'+self._esc(d.degraded.join('、'))+'</div>';
          if ((d.errors||[]).length) html += '<div style="background:#fff1f0;border-radius:8px;padding:6px 10px;font-size:12px;color:#cf1322;margin-top:6px;">采集器错误 '+d.errors.length+' 条</div>';
          html += '<div style="color:#8c8c8c;font-size:11px;text-align:right;margin-top:8px;">'+(d.source==='agent'
            ? '数据来源：心跳快照（'+(d.dataAgeSec!=null?d.dataAgeSec:'?')+' 秒前上报，每 30 秒自动更新）'
            : '数据来源：实时抓取')+'</div>';
        }
        html += '<div id="m-galio-host" style="margin-top:10px;">'+(self._galioCache || '<div class="m-form-section-title">主机状态 <span style="font-size:11px;opacity:.5;font-weight:normal;">Galio 巡检</span></div><div style="font-size:11px;color:#999;padding:4px;">加载中...</div>')+'</div>';
        return html;
      };
      var isAdmin = API.currentUser && (API.currentUser.role === 'admin' || API.currentUser.role === 'superadmin');
      var actionsBar = '<div class="m-ms-info-actions">'+
        '<button class="m-ms-act" id="m-ms-info-refresh" onclick="M._msInfoLive()">&#8635; 实时刷新</button>'+
        (isAdmin
          ? '<button class="m-ms-act" id="m-ms-info-cmds" onclick="M._msOpenCmdSheet(\''+self._esc(num)+'\')">&#9881; 维护操作</button>'
          : '')+
        '</div>';
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">'+self._esc(num)+' · 机器状态信息</div>'+
        '<button class="m-modal-close" onclick="M.closeModal()">×</button></div>'+
        '<div id="m-ms-info-body" style="max-height:70vh;overflow-y:auto;"><div class="m-empty"><div class="m-empty-text">正在从采集器读取状态...</div></div></div>'+
        actionsBar);
      var load = async function(forceLive) {
        var el = document.getElementById('m-ms-info-body');
        if (!el) { if (self._msInfoTimer) { clearInterval(self._msInfoTimer); self._msInfoTimer = null; } if (self._msInfoCtrl) { try { self._msInfoCtrl.abort(); } catch (e) { } self._msInfoCtrl = null; } if (self._galioTimer) { clearInterval(self._galioTimer); self._galioTimer = null; } self._msInfoLoad = null; return; }
        var d = null, errMsg = null;
        try {
          d = await API.getMachineInfo(num, forceLive ? { refresh: true } : undefined);
          if (d === null) errMsg = '无法连接服务器，请检查网络后重试';
        } catch(e) { errMsg = '无法连接采集器：'+(e && e.message ? e.message : '网络错误'); }
        var cur = document.getElementById('m-ms-info-body');
        if (cur) cur.innerHTML = render(d, errMsg);
        self._msLoadGalioHost(num);
      };

      this._msInfoLoad = load;
      await load();
      var self2 = this;
      if (this._galioTimer) clearInterval(this._galioTimer);
      this._galioTimer = setInterval(function() { self2._msLoadGalioHost(num); }, 30000);
      this._msInfoCtrl = API.streamMachineLive(num, function(d) {
        var cur = document.getElementById('m-ms-info-body');
        if (!cur) { if (self2._msInfoCtrl) { try { self2._msInfoCtrl.abort(); } catch (e) { } self2._msInfoCtrl = null; } return; }
        cur.innerHTML = render(d, null);
      });
    },
    async _msLoadGalioHost(num) {
      var self = this;
      var box = document.getElementById('m-galio-host');
      if (!box) return;
      try {
        var resp = await fetch('http://10.5.51.216:8000/stations/by-code/'+encodeURIComponent(num)+'/latest-metrics', {signal: AbortSignal.timeout(3000)});
        var body = await resp.json();
        if (body.code !== 0 || !body.data) { var b=document.getElementById('m-galio-host'); if(b) b.innerHTML='<div style="font-size:11px;color:#999;padding:4px;">Galio 无数据</div>'; return; }
        var d = body.data.metrics || {};
        var pct = function(v) { return v != null ? (v*100).toFixed(1)+'%' : '-'; };
        var gb = function(v, warn, crit) {
          if (v == null) return '#8c8c8c';
          var p = v*100;
          if (p >= crit) return '#cf1322';
          if (p >= warn) return '#d46b08';
          return '#389e0d';
        };
        var cell2 = function(label, valHtml, color) {
          return '<div style="flex:1 1 30%;min-width:120px;background:#f7f8fa;border-radius:8px;padding:7px 9px;">'+
            '<div style="font-size:11px;opacity:.55;margin-bottom:2px;">'+label+'</div>'+
            '<div style="font-size:13px;color:'+(color||'inherit')+';font-weight:600;">'+valHtml+'</div></div>';
        };
        var html = '<div class="m-form-section-title" style="margin-top:6px;">主机状态 <span style="font-size:11px;opacity:.5;font-weight:normal;">Galio 巡检</span></div>';
        html += '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
        html += cell2('CPU', pct(d.host_cpu_used_ratio), gb(d.host_cpu_used_ratio,70,90));
        html += cell2('内存', pct(d.host_mem_used_ratio), gb(d.host_mem_used_ratio,70,90));
        html += cell2('磁盘', pct(d.host_disk_used_ratio), gb(d.host_disk_used_ratio,75,90));
        html += cell2('负载', d.host_load1!=null?Number(d.host_load1).toFixed(2):'-', d.host_load1!=null&&d.host_load1>8?'#cf1322':d.host_load1!=null&&d.host_load1>4?'#d46b08':'#389e0d');
        html += '</div>';
        var cur = document.getElementById('m-galio-host');
        if (cur) cur.innerHTML = html;
        self._galioCache = html;
      } catch(e) {
        var cur2 = document.getElementById('m-galio-host');
        if (cur2) cur2.innerHTML = self._galioCache || '';
      }
    },
    async _msInfoLive() {
      if (this._msInfoLoading) return;
      this._msInfoLoading = true;
      var btn = document.getElementById('m-ms-info-refresh');
      if (btn) { btn.disabled = true; btn.innerHTML = '刷新中...'; }
      try { if (this._msInfoLoad) await this._msInfoLoad(true); }
      finally {
        var b = document.getElementById('m-ms-info-refresh');
        if (b) { b.disabled = false; b.innerHTML = '&#8635; 实时刷新'; }
        this._msInfoLoading = false;
      }
    },
    _msOpenCmdSheet(num) {
      this._msCloseSheet();
      var self = this;
      var D = this._msData || {};
      var latest = D.latestMap && D.latestMap[num];
      var qi = latest && latest.questInfo;
      var hasQuest = !!(qi && qi.serialNumber);
      var latestProfile = latest && (latest.machineProfile || latest.edgeMachineProfile);
      var latestMachineType = latest && (latest.machineType || (latestProfile && latestProfile.machineType));
      var isGloveOnly = latestMachineType === 'glove_only'
        || latestMachineType === 'glove'
        || (latest && latest.deviceType === 'glove')
        || (latest && /(?:纯手套|glove[_-]?only)/i.test(String(latest.equipmentType || latest.equipmentTypeName || '')));
      if (!hasQuest && latestMachineType !== 'glove_only') {
        var numM = /(?:we|szx3)-(\d+)/.exec(num || '');
        hasQuest = numM && parseInt(numM[1], 10) >= 100;
      }
      var items = '';
      if (hasQuest && !isGloveOnly) items += '<button class="m-sheet-item m-sheet-item-fix" id="m-sheet-diag" onclick="M._msChooseDiagnoseHands(\''+self._esc(num)+'\')">&#128269; 灵巧手检测（故障/温度/电压/通信）</button>'+
        '<button class="m-sheet-item m-sheet-item-fix" id="m-sheet-fix" onclick="M._msSheetCmd(\'fix\',\''+self._esc(num)+'\')">修复 Quest 连接（授权相机并重启应用）</button>'+
        '<button class="m-sheet-item m-sheet-item-fix" id="m-sheet-cfg" onclick="M._msMachineConfig(\''+self._esc(num)+'\')">&#128221; 查看机器配置</button>';
      // 机械臂入口不依赖 Quest SN/实时快照，避免采集器未启动时维护弹窗无法打开。
      if (!isGloveOnly) items += '<button class="m-sheet-item m-sheet-item-fix" id="m-sheet-arm" onclick="M._msArmControl(\''+self._esc(num)+'\')">&#129302; 机械臂状态切换</button>';
      var collectorStatus = latest && latest.containerRoleStatus && latest.containerRoleStatus.collector;
      var collectorName = (collectorStatus && collectorStatus.name) || (latest && latest.containerRoles && latest.containerRoles.collector) || 'main';
      var collectorState = collectorStatus && collectorStatus.running === false ? (collectorStatus.status || '已停止') : '运行中';
      items += '<button class="m-sheet-item m-sheet-item-danger" id="m-sheet-mono" onclick="M._msSheetCmd(\'mono\',\''+self._esc(num)+'\')">&#9632; 停止 '+self._esc(collectorName)+' 容器（'+self._esc(collectorState)+'）</button>'+
        '<button class="m-sheet-item m-sheet-item-danger" id="m-sheet-exodus" onclick="M._msSheetCmd(\'exodus\',\''+self._esc(num)+'\')">&#9632; 停止 exodus 容器</button>'+
        '<div class="m-sheet-sep">&#9881; 运维命令</div><div id="m-sheet-cmdlist"><div class="m-empty-text" style="padding:8px 0;font-size:12px;">命令加载中...</div></div>';
      var html = '<div class="m-sheet-mask" id="m-cmd-sheet" onclick="if(event.target===this)M._msCloseSheet()">'+
        '<div class="m-sheet"><div class="m-sheet-title">'+self._esc(num)+' · 维护操作</div>'+
        items+
        '<button class="m-sheet-item m-sheet-cancel" onclick="M._msCloseSheet()">取消</button></div></div>';
      document.body.insertAdjacentHTML('beforeend', html);
      this._msLoadCmdButtons(num);
    },
    async _msLoadCmdButtons(num) {
      var self = this;
      var box = document.getElementById('m-sheet-cmdlist');
      if (!box) return;
      try {
        var r = await API.getMachineCommands(num);
        if (!r || !r.success || !r.commands || !r.commands.length) {
          box.innerHTML = '<div class="m-empty-text" style="padding:8px 0;font-size:12px;">无可用命令</div>';
          return;
        }
        var html = '';
        for (var i = 0; i < r.commands.length; i++) {
          var c = r.commands[i];
          var cls = c.danger ? 'm-sheet-item-danger' : 'm-sheet-item-fix';
          html += '<button class="m-sheet-item '+cls+'" id="m-cmd-'+c.key+'" onclick="M._msExecCmd(\''+c.key+'\',\''+self._esc(num)+'\',\''+self._esc(c.label)+'\')">'+self._esc(c.label)+'</button>';
        }
        box.innerHTML = html;
      } catch (e) {
        box.innerHTML = '<div class="m-empty-text" style="padding:8px 0;font-size:12px;">命令加载失败</div>';
      }
    },
    async _msExecCmd(key, num, label) {
      var btn = document.getElementById('m-cmd-'+key);
      var sheet = document.getElementById('m-cmd-sheet');
      var self = this;
      if (!confirm('执行「'+label+'」？')) return;
      if (sheet) sheet.querySelectorAll('.m-sheet-item').forEach(function(b){ b.disabled = true; });
      if (btn) btn.innerHTML = '执行中...';
      try {
        var r = await API.runMachineCommand(num, key);
        if (r && r.success && r.output) {
          this._msCloseSheet();
          this.openModal('<div class="m-modal-header"><div class="m-modal-title">'+self._esc(label)+'</div>'+
            '<button class="m-modal-close" onclick="M.closeModal()">×</button></div>'+
            this._msFormatCmdOutput(key, r.output));
          return;
        }
        this._msCloseSheet();
        if (r && r.success) this.toast(label+' 执行成功');
        else this.toast((r && r.error) || '执行失败');
      } catch (e) {
        this._msCloseSheet();
        this.toast((e && e.message) || '执行失败');
      }
    },
    _msCloseSheet() {
      var el = document.getElementById('m-cmd-sheet');
      if (el) el.remove();
    },
    // 把命令输出转成友好展示：docker ps 表格输出 → HTML 表格；其他命令 → 等宽文本
    _msFormatCmdOutput(key, output) {
      var self = this;
      var text = String(output || '');
      var lines = text.split('\n').map(function(s){ return s.replace(/\r/g,''); }).filter(function(s){ return s.trim() !== ''; });
      var isDockerPs = /^CONTAINER\s+ID\s+IMAGE/.test(lines[0] || '');
      if (isDockerPs) {
        // docker ps 列间以 2+ 空格分隔（COMMAND 列内部是单空格，不会被误拆）
        var rows = lines.map(function(line){ return line.split(/\s{2,}/).map(function(c){ return c.trim(); }); });
        var header = rows[0] || [];
        var html = '<div style="overflow-x:auto;max-height:65vh;">'+
          '<table style="border-collapse:collapse;font-size:12px;white-space:nowrap;">'+
          '<tr>' + header.map(function(h){
            return '<th style="text-align:left;padding:5px 8px;background:#f5f5f5;border-bottom:1px solid #ddd;position:sticky;top:0;">'+self._esc(h)+'</th>';
          }).join('') + '</tr>';
        for (var i = 1; i < rows.length; i++) {
          var r = rows[i];
          // 截断超长列（如 COMMAND 参数），避免撑爆表格
          var cells = r.map(function(c){
            var t = c.length > 40 ? c.slice(0, 40) + '…' : c;
            return '<td style="padding:5px 8px;border-bottom:1px solid #f0f0f0;">'+self._esc(t)+'</td>';
          });
          // 列数不足时补齐，避免错位
          while (cells.length < header.length) cells.push('<td style="padding:5px 8px;">-</td>');
          html += '<tr>' + cells.join('') + '</tr>';
        }
        html += '</table></div>';
        return html;
      }
      return '<pre style="max-height:65vh;overflow:auto;margin:0;padding:12px 14px;font-size:12px;white-space:pre-wrap;word-break:break-all;">'+self._esc(text)+'</pre>';
    },
    async _msSheetCmd(kind, num) {
      var label = kind === 'fix' ? '修复 Quest 连接？将授权相机权限并重启 Quest 应用，约需 1 分钟'
        : kind === 'mono' ? '停止 ' + num + ' 的 mono 容器？'
        : '停止 ' + num + ' 的 exodus 容器？';
      if (!confirm(label)) return;
      var btnId = kind === 'fix' ? 'm-sheet-fix' : kind === 'mono' ? 'm-sheet-mono' : 'm-sheet-exodus';
      var btn = document.getElementById(btnId);
      var running = kind === 'fix' ? '修复中... 约需 1 分钟' : '停止中...';
      var sheet = document.getElementById('m-cmd-sheet');
      if (sheet) sheet.querySelectorAll('.m-sheet-item').forEach(function(b){ b.disabled = true; });
      if (btn) btn.innerHTML = running;
      try {
        var r, okMsg, errMsg;
        if (kind === 'fix') { r = await API.fixQuest(num); okMsg = 'Quest 已修复，应用已重启'; errMsg = '修复失败'; }
        else if (kind === 'mono') { r = await API.stopCollector(num); okMsg = (r && r.container ? r.container : '采集器') + ' 容器已停止'; errMsg = '操作失败'; }
        else { r = await API.stopExodus(num); okMsg = 'exodus 容器已停止'; errMsg = '操作失败'; }
        this._msCloseSheet();
        if (r && r.success) this.toast(okMsg);
        else this.toast((r && r.error) || errMsg);
      } catch (e) {
        this._msCloseSheet();
        this.toast((e && e.message) || '操作失败');
      }
    },
    async _msMachineConfig(num) {
      this._msCloseSheet();
      var self = this;
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">'+self._esc(num)+' · 机器配置</div>'+
        '<button class="m-modal-close" onclick="M.closeModal()">×</button></div>'+
        '<div style="max-height:65vh;overflow-y:auto;padding:0 14px;"><div class="m-empty"><div class="m-empty-text">加载中...</div></div></div>');
      try {
        var r = await API.getMachineConfig(num);
        if (!r || !r.success) {
          this.openModal('<div class="m-modal-header"><div class="m-modal-title">'+self._esc(num)+' · 机器配置</div>'+
            '<button class="m-modal-close" onclick="M.closeModal()">×</button></div>'+
            '<div style="padding:14px;"><div style="color:#cf1322;font-size:13px;">'+self._esc((r&&r.error)||'读取失败')+'</div></div>');
          return;
        }
        var cfg = r.config || {};
        var rows = [];
        var kv = function(label, val) { return '<div class="m-detail-row"><div class="m-detail-label">'+label+'</div><div class="m-detail-value" style="word-break:break-all;">'+self._esc(String(val))+'</div></div>'; };
        rows.push(kv('机器 ID', cfg.misc && cfg.misc.machine_id || '-'));
        rows.push(kv('电脑 ID', cfg.misc && cfg.misc.computer_id || '-'));
        rows.push(kv('采集器类型', cfg.collector && cfg.collector.type || '-'));
        rows.push(kv('工作流', cfg.collector && cfg.collector.workflow || '-'));
        rows.push(kv('通道', cfg.collector && cfg.collector.channel || '-'));
        if (cfg.robot) {
          if (cfg.robot.wuji_hand_l) rows.push(kv('左手 IP', cfg.robot.wuji_hand_l.ip));
          if (cfg.robot.wuji_hand_r) rows.push(kv('右手 IP', cfg.robot.wuji_hand_r.ip));
          if (cfg.robot.polling_rate) rows.push(kv('轮询率', cfg.robot.polling_rate + ' Hz'));
        }
        if (cfg.commander && cfg.commander.gello) {
          if (cfg.commander.gello.quest_controller) rows.push(kv('Quest 控制器', cfg.commander.gello.quest_controller.ip + ':' + cfg.commander.gello.quest_controller.port));
          if (cfg.commander.gello.wuji_glove_l) rows.push(kv('左手套', cfg.commander.gello.wuji_glove_l.gello_type));
          if (cfg.commander.gello.wuji_glove_r) rows.push(kv('右手套', cfg.commander.gello.wuji_glove_r.gello_type));
        }
        if (cfg.cameras) {
          var camKeys = Object.keys(cfg.cameras);
          camKeys.forEach(function(k) {
            var c = cfg.cameras[k];
            rows.push(kv('相机 ' + k, (c.type||'?') + ' ' + (c.width||'?') + 'x' + (c.height||'?') + '@' + (c.fps||'?') + 'fps'));
          });
        }
        if (cfg.storage) {
          rows.push(kv('数据目录', cfg.storage.data || '-'));
          rows.push(kv('日志目录', cfg.storage.log || '-'));
          if (cfg.storage.format) rows.push(kv('MCAP 格式', cfg.storage.format.mcap_schema + (cfg.storage.format.mcap_stream ? ' (stream)' : '')));
        }
        if (cfg.collector && cfg.collector.aux) {
          rows.push(kv('辅助节点', cfg.collector.aux.map(function(a){ return a.name; }).join(', ')));
        }
        var rawToggle = '<details style="margin-top:10px;"><summary style="font-size:13px;color:#6b7280;cursor:pointer;">原始 JSON</summary><pre style="font-size:11px;line-height:1.4;background:#f9fafb;border-radius:6px;padding:10px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;">'+self._esc(r.raw || '')+'</pre></details>';
        this.openModal('<div class="m-modal-header"><div class="m-modal-title">'+self._esc(num)+' · 机器配置</div>'+
          '<button class="m-modal-close" onclick="M.closeModal()">×</button></div>'+
          '<div style="max-height:65vh;overflow-y:auto;padding:0 14px;"><div class="m-form-section">'+rows.join('')+'</div>'+rawToggle+'</div>');
      } catch (e) {
        this.openModal('<div class="m-modal-header"><div class="m-modal-title">'+self._esc(num)+' · 机器配置</div>'+
          '<button class="m-modal-close" onclick="M.closeModal()">×</button></div>'+
          '<div style="padding:14px;"><div style="color:#cf1322;font-size:13px;">'+self._esc((e&&e.message)||'加载失败')+'</div></div>');
      }
    },

    _msArmControl(num) {
      this._msCloseSheet();
      var self = this;
      var selectedArm = 'AB';
      var armTabs = [
        { key: 'A', label: '左臂' },
        { key: 'B', label: '右臂' },
        { key: 'AB', label: '双臂' }
      ];
      var states = [
        { val: 0, label: '下伺服', color: '#8b5cf6', desc: '停止使能' },
        { val: 1, label: '位置跟随', color: '#10b981', desc: '位置模式' },
        { val: 2, label: 'PVT', color: '#3b82f6', desc: 'PVT' },
        { val: 3, label: '扭矩', color: '#f59e0b', desc: '扭矩模式' },
        { val: 4, label: '协作释放', color: '#ec4899', desc: '释放模式' }
      ];
      var renderModal = function() {
        var armHtml = armTabs.map(function(t) {
          return '<button class="m-arm-tab ' + (selectedArm === t.key ? 'active' : '') + '" onclick="M._armSelect(\''+t.key+'\')">' + t.label + '</button>';
        }).join('');
        var stateHtml = states.map(function(s) {
          return '<button class="m-arm-state-btn" style="border-color:' + s.color + ';color:' + s.color + '" onclick="M._armSetState(' + s.val + ',\'' + self._esc(num) + '\')">' +
            '<span class="m-arm-state-label">' + s.label + '</span>' +
            '<span class="m-arm-state-code">' + s.desc + '</span></button>';
        }).join('');
        return '<div class="m-modal-header"><div class="m-modal-title">🤖 ' + self._esc(num) + ' · 机械臂状态切换</div>' +
          '<button class="m-modal-close" onclick="M.closeModal()">×</button></div>' +
          '<div style="max-height:70vh;overflow-y:auto;padding:14px;">' +
          '<div class="m-arm-tabs">' + armHtml + '</div>' +
          '<div class="m-arm-section-title">连接会话</div>' +
          '<div class="m-arm-action-row">' +
            '<button class="m-arm-action-btn" style="border-color:#2563eb;color:#2563eb" onclick="M._armSession(\'connect\',\''+self._esc(num)+'\')">连接机械臂</button>' +
            '<button class="m-arm-action-btn" style="border-color:#ef4444;color:#ef4444" onclick="M._armSession(\'disconnect\',\''+self._esc(num)+'\')">退出并释放端口</button>' +
          '</div>' +
          '<div class="m-arm-section-title">状态切换</div>' +
          '<div class="m-arm-state-grid">' + stateHtml + '</div>' +
          '<div class="m-arm-section-title">操作</div>' +
          '<div class="m-arm-action-row">' +
            '<button class="m-arm-action-btn" style="border-color:#3b82f6;color:#3b82f6" onclick="M._armAction(\'clear_error\',\''+self._esc(num)+'\')">清错</button>' +
            '<button class="m-arm-action-btn" style="border-color:#ef4444;color:#ef4444" onclick="M._armAction(\'soft_stop\',\''+self._esc(num)+'\')">软急停</button>' +
            '<button class="m-arm-action-btn" style="border-color:#6b7280;color:#6b7280" onclick="M._armAction(\'get_errors\',\''+self._esc(num)+'\')">查看错误码</button>' +
          '</div>' +
          '<details class="m-arm-advanced" open><summary>位置跟踪 / 阻抗参数</summary>' +
          '<div class="m-arm-param-grid"><label>速度比例 <input id="m-arm-vel" type="number" min="1" max="100" value="10"></label><label>加速度比例 <input id="m-arm-acc" type="number" min="1" max="100" value="10"></label></div>' +
          '<button class="m-arm-wide-btn" onclick="M._armApplyMode(\'set_joint_mode\',\''+self._esc(num)+'\')">应用位置跟踪参数</button>' +
          '<div class="m-arm-param-label">阻抗类型</div><select id="m-arm-imp-type" class="m-arm-select"><option value="joint">关节阻抗</option><option value="cart">笛卡尔阻抗</option></select>' +
          '<div class="m-arm-param-label">刚度 K（7 个值，逗号分隔）</div><input id="m-arm-k" class="m-arm-text" value="10,10,10,1.6,1,1,1">' +
          '<div class="m-arm-param-label">阻尼 D（7 个值，0~1，逗号分隔）</div><input id="m-arm-d" class="m-arm-text" value="0.8,0.8,0.8,0.4,0.4,0.4,0.4">' +
          '<div id="m-arm-cart-extra" style="display:none"><div class="m-arm-param-grid"><label>旋转类型 <select id="m-arm-rot"><option value="0">不定义</option><option value="1">自定义</option><option value="2">系统自动</option></select></label><label>方向参数 <input id="m-arm-cart-para" type="text" value="0,0,0,0,0,0,0"></label></div></div>' +
          '<button class="m-arm-wide-btn" onclick="M._armApplyMode(\'set_impedance\',\''+self._esc(num)+'\')">应用阻抗参数</button>' +
          '</details>' +
          '<div class="m-arm-section-title">拖拽模式</div><div class="m-arm-action-row m-arm-drag-row">' +
            '<button class="m-arm-action-btn" onclick="M._armApplyMode(\'joint_drag\',\''+self._esc(num)+'\')">关节拖拽</button>' +
            '<button class="m-arm-action-btn" onclick="M._armApplyMode(\'cart_drag\',\''+self._esc(num)+'\',\'X\')">X</button>' +
            '<button class="m-arm-action-btn" onclick="M._armApplyMode(\'cart_drag\',\''+self._esc(num)+'\',\'Y\')">Y</button>' +
            '<button class="m-arm-action-btn" onclick="M._armApplyMode(\'cart_drag\',\''+self._esc(num)+'\',\'Z\')">Z</button>' +
            '<button class="m-arm-action-btn" onclick="M._armApplyMode(\'cart_drag\',\''+self._esc(num)+'\',\'R\')">旋转</button>' +
            '<button class="m-arm-action-btn" onclick="M._armApplyMode(\'exit_drag\',\''+self._esc(num)+'\')">退出</button>' +
          '</div>' +
          '<details class="m-arm-advanced"><summary>工具设置（末端负载）</summary>' +
          '<div class="m-arm-param-grid"><label>工具质量 kg <input id="m-arm-mass" type="number" min="0" step="0.001" value="0"></label><label>质心 X/Y/Z m <input id="m-arm-com" type="text" value="0,0,0"></label></div>' +
          '<div class="m-arm-param-label">工具位姿 XYZABC（毫米、度）</div><input id="m-arm-kine" class="m-arm-text" value="0,0,0,0,0,0">' +
          '<div class="m-arm-param-label">惯量 Ixx,Ixy,Ixz,Iyy,Iyz,Izz</div><input id="m-arm-inertia" class="m-arm-text" value="0,0,0,0,0,0">' +
          '<button class="m-arm-wide-btn" onclick="M._armApplyTool(\''+self._esc(num)+'\')">保存工具设置</button></details>' +
          '<div id="m-arm-result" class="m-arm-result" aria-live="polite"></div>' +
          '<div style="margin-top:10px;font-size:11px;color:#9ca3af;line-height:1.5;">机械臂 IP: 192.168.1.190 | A=左臂 B=右臂</div>' +
          '</div>';
      };
      self._armSelected = selectedArm;
      self.openModal(renderModal());
      var impSelect = document.getElementById('m-arm-imp-type');
      if (impSelect) impSelect.addEventListener('change', function() {
        var extra = document.getElementById('m-arm-cart-extra');
        if (extra) extra.style.display = this.value === 'cart' ? 'block' : 'none';
      });
      var styleId = 'm-arm-style';
      if (!document.getElementById(styleId)) {
        var st = document.createElement('style');
        st.id = styleId;
        st.textContent = '.m-arm-tabs{display:flex;gap:8px;margin-bottom:16px}.m-arm-tab{flex:1;padding:10px 8px;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb;font-size:14px;font-weight:600;color:#6b7280;cursor:pointer;transition:all .15s}.m-arm-tab.active{background:#1f2937;color:#fff;border-color:#1f2937}' +
          '.m-arm-section-title{font-size:13px;font-weight:600;color:#374151;margin-bottom:10px;margin-top:8px}.m-arm-state-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}' +
          '.m-arm-state-btn{display:flex;flex-direction:column;align-items:center;padding:14px 8px;border:2px solid;border-radius:10px;background:#fff;cursor:pointer;transition:all .15s}.m-arm-state-btn:active{transform:scale(.97)}.m-arm-state-label{font-size:15px;font-weight:700}.m-arm-state-code{font-size:10px;color:#9ca3af;margin-top:2px}' +
          '.m-arm-action-row{display:flex;gap:10px;flex-wrap:wrap}.m-arm-action-btn{flex:1;padding:12px;border:2px solid;border-radius:10px;background:#fff;font-size:14px;font-weight:600;cursor:pointer;transition:all .15s}.m-arm-action-btn:active{transform:scale(.97)}' +
          '.m-arm-advanced{margin-top:14px;border:1px solid #e5e7eb;border-radius:8px;padding:10px}.m-arm-advanced summary{font-size:13px;font-weight:600;color:#374151;cursor:pointer}.m-arm-param-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.m-arm-param-grid label{font-size:11px;color:#6b7280}.m-arm-param-grid input,.m-arm-select,.m-arm-text{box-sizing:border-box;width:100%;margin-top:4px;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;background:#fff}.m-arm-param-label{font-size:11px;color:#6b7280;margin-top:9px}.m-arm-wide-btn{width:100%;margin-top:10px;padding:9px;border:1px solid #2563eb;border-radius:7px;background:#eff6ff;color:#1d4ed8;font-size:12px;font-weight:600}.m-arm-drag-row{gap:6px}.m-arm-drag-row .m-arm-action-btn{min-width:42px;padding:9px 6px;font-size:12px}' +
          '.m-arm-result{position:fixed;left:50%;top:calc(64px + env(safe-area-inset-top, 0));z-index:1200;width:min(520px,calc(100vw - 28px));transform:translate(-50%,-12px);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s}.m-arm-result.show{opacity:1;transform:translate(-50%,0)}.m-arm-result-panel,.m-arm-result-content{padding:12px 14px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.16);font-size:13px;background:#fff}.m-arm-result-ok .m-arm-result-panel,.m-arm-result-ok .m-arm-result-content{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534}.m-arm-result-err .m-arm-result-panel,.m-arm-result-err .m-arm-result-content{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c}.m-arm-result-loading .m-arm-result-content{border:1px solid #e5e7eb;color:#6b7280}.m-arm-result-title{font-weight:600;margin-bottom:7px}.m-arm-result-arm{margin-top:6px;color:#4b5563;line-height:1.5}';
        document.head.appendChild(st);
      }
    },
    async _armSession(action, num) {
      var label = action === 'connect' ? '连接机械臂并占用控制端口？请确认采集器已由你手动停止。' : '退出机械臂连接并释放控制端口？';
      var go = await this._armConfirm(label, action === 'connect' ? '连接机械臂' : '释放机械臂连接');
      if (!go) return;
      this._armExec(action, num, 'AB', undefined);
    },
    _armSelect(arm) {
      this._armSelected = arm;
      var tabs = document.querySelectorAll('.m-arm-tab');
      tabs.forEach(function(t) {
        t.classList.toggle('active', t.textContent.indexOf(arm === 'A' ? '左臂' : arm === 'B' ? '右臂' : '双臂') >= 0);
      });
    },
    async _armSetState(state, num) {
      var arm = this._armSelected || 'AB';
      var stateNames = { 0: '下伺服', 1: '位置跟随', 2: 'PVT', 3: '扭矩', 4: '协作释放' };
      var go = await this._armConfirm('确认将 ' + (arm === 'A' ? '左臂' : arm === 'B' ? '右臂' : '双臂') + ' 切换到「' + (stateNames[state] || state) + '」状态？', '切换机械臂状态');
      if (!go) return;
      this._armExec('set_state', num, arm, state);
    },
    async _armAction(action, num) {
      var arm = this._armSelected || 'AB';
      var armLabel = arm === 'A' ? '左臂' : arm === 'B' ? '右臂' : '双臂';
      var actionLabel = action === 'clear_error' ? '清错' : action === 'soft_stop' ? '软急停' : '查看错误码';
      if (action !== 'get_errors') {
        var go = await this._armConfirm('确认对 ' + armLabel + ' 执行「' + actionLabel + '」？', actionLabel);
        if (!go) return;
      }
      this._armExec(action, num, arm, undefined);
    },
    _armValues(id, expected) {
      var el = document.getElementById(id);
      var values = String(el ? el.value : '').split(',').map(function(v) { return Number(v.trim()); });
      if (values.length !== expected || values.some(function(v) { return !Number.isFinite(v); })) throw new Error('参数数量或格式不正确');
      return values;
    },
    _armResultPopup(html, type) {
      var el = document.getElementById('m-arm-result');
      if (!el) return;
      if (this._armResultTimer) clearTimeout(this._armResultTimer);
      el.className = 'm-arm-result show' + (type ? ' m-arm-result-' + type : '');
      el.innerHTML = html;
      var self = this;
      this._armResultTimer = setTimeout(function() {
        el.className = 'm-arm-result';
        el.innerHTML = '';
        self._armResultTimer = null;
      }, 5000);
    },
    _armApplyMode(action, num, direction) {
      var arm = this._armSelected || 'AB';
      var options = {};
      try {
        if (action === 'set_joint_mode' || action === 'set_impedance') {
          options.velRatio = Number(document.getElementById('m-arm-vel').value);
          options.accRatio = Number(document.getElementById('m-arm-acc').value);
          if (!Number.isInteger(options.velRatio) || options.velRatio < 1 || options.velRatio > 100 || !Number.isInteger(options.accRatio) || options.accRatio < 1 || options.accRatio > 100) throw new Error('速度和加速度比例需为 1-100 的整数');
        }
        if (action === 'set_impedance') {
          options.stiffness = this._armValues('m-arm-k', 7);
          options.damping = this._armValues('m-arm-d', 7);
          var type = document.getElementById('m-arm-imp-type').value;
          action = type === 'cart' ? 'set_impedance_cart' : 'set_impedance_joint';
          if (type === 'cart') {
            options.rotType = Number(document.getElementById('m-arm-rot').value);
            options.cartCtrlPara = this._armValues('m-arm-cart-para', 7);
          }
        } else if (action === 'cart_drag') options.direction = direction;
      } catch (e) {
        this._armResultPopup('<div class="m-arm-result-content">❌ ' + this._esc(e.message) + '</div>', 'err');
        return;
      }
      this._armExec(action, num, arm, undefined, options);
    },
    _armApplyTool(num) {
      var arm = this._armSelected || 'AB';
      try {
        var kine = this._armValues('m-arm-kine', 6);
        var com = this._armValues('m-arm-com', 3);
        var inertia = this._armValues('m-arm-inertia', 6);
        var mass = Number(document.getElementById('m-arm-mass').value);
        if (!Number.isFinite(mass) || mass < 0) throw new Error('工具质量必须为非负数');
        this._armExec('set_tool', num, arm, undefined, { kinePara: kine, dynPara: [mass].concat(com, inertia) });
      } catch (e) {
        this._armResultPopup('<div class="m-arm-result-content">❌ ' + this._esc(e.message) + '</div>', 'err');
      }
    },
    async _armExec(action, num, arm, state, options) {
      var self = this;
      this._armResultPopup('<div class="m-arm-result-content">执行中...</div>', 'loading');
      try {
        var r = await API.armControl(num, action, arm, state, options);
        if (r && r.success) {
          if (action === 'connect' || action === 'disconnect') {
            var sessionText = action === 'connect'
              ? (r.connected ? '机械臂已连接，可开始操作' : '已请求连接，但机械臂暂未返回实时帧')
              : '已退出机械臂连接，4730 端口已释放';
            var sessionPrefix = r.sdkCalled ? 'SDK 已调用 · ' : '';
            self._armResultPopup('<div class="m-arm-result-content">✅ ' + self._esc(sessionPrefix + sessionText) + '</div>', r.connected || action === 'disconnect' ? 'ok' : 'loading');
            return;
          }
          if (action === 'get_errors') {
            var errors = r.errors || {};
            var hasError = r.hasError;
            var html = '<div class="m-arm-result-panel ' + (hasError ? 'is-error' : 'is-ok') + '">';
            html += '<div class="m-arm-result-title">' + (r.sdkCalled ? 'SDK 已调用 · ' : '') + (hasError ? '⚠️ 检测到伺服错误' : '✅ 无伺服错误') + '</div>';
            for (var a in errors) {
              var armLabel = a === 'A' ? '左臂' : '右臂';
              var armErrs = errors[a];
              if (armErrs && armErrs.length) {
                html += '<div class="m-arm-result-arm"><b>' + armLabel + '：</b>';
                armErrs.forEach(function(e) {
                  html += '<div>关节' + e.joint + ' ' + e.code + ' ' + self._esc(e.description) + '</div>';
                });
                html += '</div>';
              }
            }
            if (!hasError) html += '<div>两臂所有关节伺服状态正常</div>';
            html += '</div>';
            self._armResultPopup(html, hasError ? 'err' : 'ok');
          } else {
            var stateLabels = {
              IDLE: '下伺服', POSITION: '位置跟随', PVT: 'PVT', TORQUE: '扭矩', RELEASE: '协作释放',
              UNKNOWN: '未知状态',
            };
            var stateName = action === 'soft_stop'
              ? '下伺服'
              : (r.stateName ? (stateLabels[r.stateName] || stateLabels[String(r.stateName).toUpperCase()] || r.stateName)
                : (stateLabels[r.state] || ''));
            var msg = (r.sdkCalled ? 'SDK 已调用 · ' : '') + (stateName ? ('状态: ' + stateName) : '操作成功');
            if (r.applied) {
              if (r.applied.velRatio !== undefined) msg += ' · 速度 ' + r.applied.velRatio + '% · 加速度 ' + r.applied.accRatio + '%';
              if (r.applied.massKg !== undefined) msg += ' · 工具质量 ' + r.applied.massKg + ' kg';
              if (r.applied.direction) msg += ' · 方向 ' + r.applied.direction;
            }
            self._armResultPopup('<div class="m-arm-result-content">✅ ' + self._esc(msg) + '</div>', 'ok');
          }
        } else {
          var errorLabels = {
            frame_stale: '实时反馈帧已超时，请检查机械臂连接',
            frame_unavailable: '暂未收到机械臂实时反馈帧',
            realtime_frame_unavailable: '实时反馈帧不可用，请检查机械臂连接',
            soft_stop_not_confirmed: '软急停未得到机械臂反馈确认',
          };
          var errorCode = r && (r.errorCode || r.error);
          var errorText = errorLabels[errorCode] || (r && r.error) || '操作失败';
          self._armResultPopup('<div class="m-arm-result-content">❌ ' + self._esc(errorText) + '</div>', 'err');
        }
      } catch (e) {
        self._armResultPopup('<div class="m-arm-result-content">❌ ' + self._esc((e && e.message) || '网络错误') + '</div>', 'err');
      }
    },

    _msChooseDiagnoseHands(num) {
      this._msCloseSheet();
      var self = this;
      var n = self._esc(num);
      var choose = function(scope) {
        return 'M._msDiagnoseHands(\''+n+'\',\''+scope+'\')';
      };
      self.openModal('<div class="m-modal-header"><div class="m-modal-title">'+n+' · 灵巧手检测</div><button class="m-modal-close" onclick="M.closeModal()">×</button></div>'+
        '<div class="m-form-section"><div class="m-field-label" style="margin-bottom:10px;">检测范围</div>'+
        '<div style="display:flex;flex-direction:column;gap:8px;">'+
        '<button class="m-ms-act" style="width:100%;" onclick="'+choose('all')+'">全部灵巧手</button>'+
        '<button class="m-ms-act" style="width:100%;" onclick="'+choose('left')+'">仅左手</button>'+
        '<button class="m-ms-act" style="width:100%;" onclick="'+choose('right')+'">仅右手</button></div></div>'+
        '<div class="m-btn-row"><button class="m-btn m-btn-outline m-btn-block" onclick="M.closeModal()">取消</button></div>');
    },
    async _msDiagnoseHands(num, side) {
      if (side !== 'left' && side !== 'right' && side !== 'all') {
        this._msChooseDiagnoseHands(num);
        return;
      }
      this._msCloseSheet();
      var self = this;
      var scopeLabel = side === 'left' ? '仅左手' : side === 'right' ? '仅右手' : '全部灵巧手';
      var render = function(body, loading) {
        self.openModal('<div class="m-modal-header"><div class="m-modal-title">'+self._esc(num)+' · 灵巧手检测 · '+scopeLabel+'</div>'+
          '<button class="m-modal-close" onclick="M.closeModal()">×</button></div>'+
          '<div style="max-height:60vh;overflow-y:auto;padding:0 14px;">'+body+'</div>'+
          '<div style="padding:0 14px;"><div class="m-ms-info-actions"><button class="m-ms-act" id="m-diag-retry" '+(loading?'disabled':'onclick="M._msDiagnoseHands(\''+self._esc(num)+'\',\''+side+'\')"')+'>'+(loading?'检测中... 约需 1 分钟':'&#8635; 重新检测')+'</button></div></div>');
      };
      // —— 进度条模式：先展示进度，轮询 agent 实时状态，检测完成后再渲染结果 ——
      var progHtml = function(pct, msg, sub) {
        return '<div style="padding:4px 2px 12px;">'+
          '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;margin-bottom:8px;">'+
          '<span id="m-diag-msg" style="color:var(--text2);">'+self._esc(msg||'')+'</span>'+
          '<span id="m-diag-pct" style="font-family:monospace;font-weight:700;color:#1677ff;">'+Math.round(pct||0)+'%</span></div>'+
          '<div style="height:8px;border-radius:4px;background:#f0f0f0;overflow:hidden;">'+
          '<div id="m-diag-bar" style="width:'+Math.round(pct||0)+'%;height:100%;background:linear-gradient(90deg,#69b1ff,#1677ff);border-radius:4px;transition:width .5s ease;"></div></div>'+
          (sub?'<div id="m-diag-sub" style="font-size:12px;font-family:monospace;color:var(--text3);margin-top:6px;">'+self._esc(sub)+'</div>':'')+
          '</div>';
      };
      var setProgress = function(pct, msg, sub) {
        var bar = document.getElementById('m-diag-bar');
        if (!bar) return false; // 弹窗已关闭，停止轮询
        bar.style.width = Math.max(0, Math.min(100, Math.round(pct)))+'%';
        var pctEl = document.getElementById('m-diag-pct');
        if (pctEl) pctEl.textContent = Math.round(pct)+'%';
        var msgEl = document.getElementById('m-diag-msg');
        if (msgEl) msgEl.textContent = msg || '';
        var subEl = document.getElementById('m-diag-sub');
        if (subEl) subEl.textContent = sub || '';
        var retry = document.getElementById('m-diag-retry');
        if (retry) retry.textContent = '检测中... '+Math.round(pct)+'%';
        return true;
      };
      var sideOf = function(sn) {
        if (!sn || sn.length < 4) return '';
        var c = sn[3]; return c === 'J' ? '左手' : (c === 'K' ? '右手' : '');
      };
      render(progHtml(6, '正在发送检测请求...'), true);
      var pollTimer = null;
      var stopPoll = function() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
      var pollOnce = async function() {
        try {
          var pr = await API.diagnoseProgress(num, side);
          if (!pr || !pr.success || !pr.progress) return;
          var p = pr.progress;
          var pct;
          if (p.phase === 'scan') pct = 8;
          else if (p.phase === 'diag') pct = 10 + Math.round(((p.current||0) / Math.max(p.total||1, 1)) * 82);
          else if (p.phase === 'done') pct = 98;
          else if (p.phase === 'error') pct = 96;
          else pct = 6;
          var snSide = sideOf(p.sn) || '';
          var sub = snSide ? (snSide + (p.sn ? '　'+p.sn : '')) : (p.sn || '');
          var keep = setProgress(pct, p.message || '', sub);
          if (!keep || p.running === false) stopPoll();
        } catch (e) { }
      };
      pollTimer = setInterval(pollOnce, 1500);
      pollOnce();
      var r;
      try {
        r = await API.diagnoseHands(num, side);
      } catch (e) {
        r = { error: (e && e.message) || '检测失败' };
      }
      stopPoll();
      setProgress(100, '检测完成，正在整理结果...', '');
      var body;
      if (!r || !r.success) {
        body = '<div style="background:#fff1f0;border-radius:8px;padding:12px;font-size:13px;color:#cf1322;margin-top:10px;">'+self._esc((r && r.error) || '检测失败（网络超时或代理无响应），可点击下方重新检测')+'</div>';
      } else {
        var hands = r.hands || [];
        if (!hands.length) body = '<div class="m-empty"><div class="m-empty-text">未发现已连接的灵巧手</div></div>';
        else {
          var allOk = hands.every(function(h){ return h.healthy; });
          body = '<div style="border-radius:8px;padding:10px;margin:10px 0;font-size:14px;font-weight:600;text-align:center;'+
            'background:'+(allOk?'#f6ffed':'#fff1f0')+';color:'+(allOk?'#389e0d':'#cf1322')+';">'+
            (allOk ? '✅ '+hands.length+' 只灵巧手全部正常' : '❌ 检测到异常，请查看详情')+'</div>';
          body += hands.map(function(h){
            var side = h.handedness === 'left' ? '左手' : h.handedness === 'right' ? '右手' : (h.handedness || '未知');
            var tempWarn = h.tempMax != null && h.tempMax >= 75;
            var voltWarn = h.voltMin != null && (h.voltMin < 11.5 || h.voltMax > 13);
            var rateWarn = h.minResponseRate != null && h.minResponseRate < 99;
            var row = function(label, val, bad, warn) {
              var color = bad ? 'color:#cf1322;' : (warn ? 'color:#d48806;' : '');
              return '<div style="display:flex;justify-content:space-between;padding:5px 2px;font-size:13px;border-bottom:1px solid var(--border);">'+
                '<span style="color:var(--text3);">'+label+'</span>'+
                '<span style="font-weight:600;text-align:right;'+color+'">'+val+'</span></div>';
            };
            var sevName = { fatal: '致命故障', immediate_stop: '立即停止', deferred_stop: '延迟停止', stop: '停止级' };
            var faultTxt = (h.faults && h.faults.length)
              ? h.faults.map(function(f){
                  var detail = (f.log && f.log.length) ? '（开机后 '+f.log.map(function(l){return l.uptime_s+'s';}).join('/')+' 记录）' : '';
                  return '❌ '+self._esc(f.joint||('nid'+f.nid))+' · '+self._esc(sevName[f.severity]||'故障')+' code '+f.code+detail;
                }).join('<br>')
              : '无';
            var warnTxt = (h.warningJoints && h.warningJoints.length)
              ? '⚠️ '+h.warningJoints.length+' 个关节警告位（空闲常态）'
              : '无';
            var headBadge = h.offline ? ' <span style="color:#cf1322;font-size:13px;">❌ 无响应/离线</span>'
              : h.healthy === true ? ' <span style="color:#389e0d;font-size:13px;">✅ 正常</span>'
              : h.healthy == null ? ' <span style="color:#d48806;font-size:13px;">⚠️ 数据未取到</span>'
              : ' <span style="color:#cf1322;font-size:13px;">❌ 异常</span>';
            return '<div style="border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:10px;">'+
              '<div style="font-weight:700;font-size:15px;margin-bottom:2px;">🤖 '+side+headBadge+'</div>'+
              '<div style="font-family:monospace;font-size:12px;color:var(--text3);margin-bottom:6px;">'+self._esc(h.sn||'-')+
              (h.firmware?' · 固件 '+self._esc(h.firmware):'')+(h.ip?' · '+self._esc(h.ip):'')+'</div>'+
              (h.offline
                ? '<div style="background:#fff1f0;border-radius:8px;padding:10px;font-size:13px;color:#cf1322;margin:4px 0;">该手在设备列表中但<strong>无任何通信响应</strong>，请检查电源、通信线缆后重新检测</div>'
                : row('停止级故障', faultTxt, !!(h.faults && h.faults.length))+
                  row('警告位', warnTxt, false, !!(h.warningJoints && h.warningJoints.length))+
                  row('在线关节', (h.jointsOnline!=null?h.jointsOnline:'?')+'/20', h.jointsOnline!=null && h.jointsOnline !== 20)+
                  row('芯片温度', (h.tempMax!=null?('最高 '+h.tempMax+'℃ / 最低 '+h.tempMin+'℃'):'-'), false, tempWarn)+
                  row('总线电压', (h.voltMin!=null?(h.voltMin+' ~ '+h.voltMax+' V'):'-'), false, voltWarn)+
                  row('通信响应率', (h.minResponseRate!=null?(h.minResponseRate+'%'):'-')+' · 超时累计 '+(h.commTimeouts||0), rateWarn))+
              '</div>';
          }).join('');
        }
      }
      render(body);
    },
    async _msShowMachineHistory(num) {
      var self = this;
      var D = this._msData;
      var PS_META = (D && D.PS_META) || {};
      // 先打开弹窗再读取接口，避免接口慢时点击没有任何反馈。
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">'+self._esc(num)+' · 生产状态变更历史</div><button class="m-modal-close" onclick="M.closeModal()">×</button></div>'+ 
        '<div class="m-form-section"><div class="m-loading">正在加载历史记录...</div></div>');
      var list = [];
      try { list = (await API.getProductionHistory(num)) || []; } catch(e) {}
      var body;
      if (!list.length) {
        body = '<div class="m-empty"><div class="m-empty-text">暂无变更记录</div></div>';
      } else {
        body = list.map(function(h){
          var oldL = h.oldStatus ? (PS_META[h.oldStatus]?PS_META[h.oldStatus].l:h.oldStatus) : '初始';
          var newMeta = PS_META[h.newStatus] || {l:h.newStatus,c:'#999'};
          var srcTag = h.source==='ticket' ? '<span style="color:#722ed1;">工单</span>' : '<span style="color:#999;">人工</span>';
          return '<div class="m-data-row"><div class="m-card-row"><div>'+
            '<div class="m-data-value" style="font-family:monospace;">'+self._esc(h.machineNumber||num)+'</div>'+
            '<div class="m-data-label">'+self._esc(h.operatorName||(h.source==='ticket'?'工单联动':'-'))+' · '+self._fmtTime(h.createdAt)+'</div></div>'+
            '<div style="text-align:right;font-size:12px;">'+self._esc(oldL)+' → <span style="color:'+newMeta.c+';font-weight:600;">'+newMeta.l+'</span><br>'+
            (h.reason?'<span style="opacity:.6;">'+self._esc(h.reason)+'</span> · ':'')+srcTag+'</div></div></div>';
        }).join('');
      }
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">'+self._esc(num)+' · 生产状态变更历史</div><button class="m-modal-close" onclick="M.closeModal()">×</button></div>'+
        '<div class="m-form-section" style="max-height:70vh;overflow-y:auto;">'+body+'</div>');
    },
    _msRenderHistory() {
      var self = this;
      var D = this._msData; if (!D) return;
      var box = document.getElementById('m-ms-history'); if (!box) return;
      var PS_META = D.PS_META;
      var list = (D.history||[]).slice(0, 50);
      if (!list.length) { box.innerHTML = '<div class="m-empty"><div class="m-empty-text">暂无变更记录</div></div>'; return; }
      var rows = list.map(function(h){
        var oldL = h.oldStatus ? (PS_META[h.oldStatus]?PS_META[h.oldStatus].l:h.oldStatus) : '初始';
        var newMeta = PS_META[h.newStatus] || {l:h.newStatus,c:'#999',bg:'#f5f5f5'};
        var srcTag = h.source==='ticket' ? '<span style="color:#722ed1;">工单</span>' : '<span style="color:#999;">人工</span>';
        return '<div class="m-data-row"><div class="m-card-row"><div>'+
          '<div class="m-data-value" style="font-family:monospace;">'+self._esc(h.machineNumber||'')+'</div>'+
          '<div class="m-data-label">'+self._esc(h.operatorName||(h.source==='ticket'?'工单联动':'-'))+' · '+self._fmtTime(h.createdAt)+'</div></div>'+
          '<div style="text-align:right;font-size:12px;">'+self._esc(oldL)+' → <span style="color:'+newMeta.c+';font-weight:600;">'+newMeta.l+'</span><br>'+
          (h.reason?'<span style="opacity:.6;">'+self._esc(h.reason)+'</span> · ':'')+srcTag+'</div></div></div>';
      }).join('');
      box.innerHTML = rows;
    },
    async _msDoSwitch(num) {
      var self = this;
      var sel = document.getElementById('m-ms-sel-'+num);
      var status = sel ? sel.value : '';
      if (!status) return;
      var reason = prompt('变更原因/备注（可选）','') || '';
      try {
        var r = await API.setProductionStatus(num, status, reason);
        if (r && r.error) { this.toast('变更失败：'+r.error, 'err'); return; }
        this.toast(num+' 已标记为「'+(this._msData.PS_META[status]||{}).l+'」', 'ok');

        var wrap = document.getElementById('m-subpage-content');
        if (wrap) { await this._renderMachineStatusPage(wrap); }
      } catch(e) { this.toast('网络错误，请稍后重试', 'err'); }
    },
    _machOnline(num) {
      var self = this;
      var D = this._machData || {};
      var eqcfg = D.eqcfg || [];
      if (!eqcfg.length) { this.toast('缺少设备类型配置，请先在【设备配置】中添加', 'err'); return; }
      var opts = eqcfg.map(function(c){
        return '<option value="'+self._esc(c.id)+'">'+self._esc((c.icon||'')+' '+c.name)+'</option>';
      }).join('');
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">'+(num?'机器上线':'新机器上线')+'</div><button class="m-modal-close" onclick="M.closeModal()">×</button></div>'+
        '<div class="m-form-section">'+
        '<div class="m-field"><label class="m-field-label">机器编号 *</label><input id="m-mach-num" class="m-input" placeholder="如 K-001（K=右手设备，J=左手设备）" value="'+self._esc(num||'')+'" '+(num?'readonly':'')+' style="font-family:monospace;"></div>'+
        '<div class="m-field"><label class="m-field-label">设备类型 *</label><select id="m-mach-type" class="m-select" onchange="M._machTypeChange()">'+opts+'</select></div>'+
        '<div id="m-mach-sn-selects"></div>'+
        '<div id="m-mach-preview" class="m-detail-row"><div class="m-detail-label">提示</div><div class="m-detail-value">将按设备类型自动扣减库存</div></div>'+
        '</div><div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">取消</button><button class="m-btn m-btn-primary" onclick="M._machSubmitOnline()">确认上线</button></div>');
      this._machTypeChange();
    },
    _machTypeChange() {
      var self = this;
      var D = this._machData || {};
      var typeId = (document.getElementById('m-mach-type')||{}).value;
      var cfg = (D.eqcfg||[]).find(function(c){ return c.id === typeId; });
      var box = document.getElementById('m-mach-sn-selects');
      if (!box) return;
      var handConsumes = ((cfg&&cfg.consumes)||[]).filter(function(c){ return c.handType; });
      var autoConsumes = ((cfg&&cfg.consumes)||[]).filter(function(c){ return !c.handType; });
      var html = handConsumes.map(function(c){
        var eqType = String(c.inventoryType).replace(/_(left|right)$/, '');
        var avail = (D.registry||[]).filter(function(s){
          return s.status === 'available' && s.equipmentType === eqType && s.handType === c.handType;
        });
        var opts = avail.length
          ? '<option value="">-- 选择'+(c.handType==='left'?'左手':'右手')+'SN --</option>' + avail.map(function(s){ return '<option value="'+self._esc(s.snCode)+'">'+self._esc(s.snCode)+'</option>'; }).join('')
          : '<option value="">（无可用库存）</option>';
        return '<div class="m-field"><label class="m-field-label">'+(c.handType==='left'?'左手':'右手')+'手套 SN'+(avail.length?'（可用 '+avail.length+'）':'（无可用）')+' *</label><select class="m-select m-mach-sn" data-hand="'+c.handType+'" data-invtype="'+self._esc(c.inventoryType)+'">'+opts+'</select></div>';
      }).join('');
      html += autoConsumes.map(function(c){
        var inv = (D.invcfg||[]).find(function(x){ return x.id === c.inventoryType; });
        return '<div class="m-detail-row"><div class="m-detail-label">自动扣减</div><div class="m-detail-value">'+self._esc(inv ? (inv.icon||'')+inv.name : c.inventoryType)+' × '+(c.quantity||1)+'</div></div>';
      }).join('');
      box.innerHTML = html;
    },
    async _machSubmitOnline() {
      var self = this;
      var D = this._machData || {};
      var num = ((document.getElementById('m-mach-num')||{}).value||'').trim().toUpperCase();
      var typeId = (document.getElementById('m-mach-type')||{}).value;
      if (!num) { this.toast('请输入机器编号', 'err'); return; }

      var bound = (D.registry||[]).filter(function(s){ return s.machineNumber === num && (s.status==='in_use'||s.status==='inUse'); });
      var hasL = bound.some(function(s){ return s.handType === 'left'; });
      var hasR = bound.some(function(s){ return s.handType === 'right'; });
      if (hasL && hasR) { this.toast('机器 '+num+' 已绑定左右手手套，无需重复上线', 'err'); return; }

      var snOps = [], seen = {}, picked = {};
      var sels = document.getElementsByClassName('m-mach-sn');
      for (var i = 0; i < sels.length; i++) {
        var sn = sels[i].value;
        if (!sn) continue;
        if (seen[sn]) { this.toast('SN '+sn+' 被重复选择', 'err'); return; }
        seen[sn] = 1;
        var owner = (D.registry||[]).find(function(s){ return (s.snCode||s.sn||s.id) === sn && (s.status==='in_use'||s.status==='inUse'); });
        if (owner && owner.machineNumber && owner.machineNumber !== num) { this.toast('SN '+sn+' 已被机器 '+owner.machineNumber+' 绑定', 'err'); return; }
        picked[sels[i].getAttribute('data-hand')] = 1;
        snOps.push({ snCode:sn, equipmentType:String(sels[i].getAttribute('data-invtype')||'').replace(/_(left|right)$/, ''), handType:sels[i].getAttribute('data-hand'), targetStatus:'in_use' });
      }

      var cfg = (D.eqcfg||[]).find(function(c){ return c.id === typeId; });
      var handConsumes = ((cfg&&cfg.consumes)||[]).filter(function(c){ return c.handType; });
      for (var j = 0; j < handConsumes.length; j++) {
        if (!picked[handConsumes[j].handType]) { this.toast('请选择'+(handConsumes[j].handType==='left'?'左手':'右手')+'SN 码', 'err'); return; }
      }
      try {
        var r = await API.syncMachineState(num, { status:'online', deviceType:typeId, reason:'', snOperations:snOps });
        if (r && r.error) { this.toast('上线失败：'+r.error, 'err'); return; }
        this.closeModal();
        this.toast('机器 '+num+' 上线成功', 'ok');
        this.showAdminSubPage('machines');
      } catch(e) { this.toast('网络错误，请稍后重试', 'err'); }
    },
    _machOffline(num) {
      var self = this;
      var D = this._machData || {};
      var bound = (D.registry||[]).filter(function(s){ return s.machineNumber === num && (s.status==='in_use'||s.status==='inUse'); });
      if (!bound.length) { this.toast('该机器没有绑定的手套', 'err'); return; }
      var rows = bound.map(function(s){
        var label = (s.handType === 'left' ? '左手' : s.handType === 'right' ? '右手' : '')+' '+self._esc(s.snCode);
        return '<div class="m-field"><label class="m-field-label">'+label+'</label>'+
          '<select class="m-select m-mach-off-act" data-sn="'+self._esc(s.snCode)+'" data-eq="'+self._esc(s.equipmentType||'')+'" data-hand="'+self._esc(s.handType||'')+'" onchange="M._machOffChange(this)">'+
          '<option value="normal">正常归还库存</option><option value="damaged">标记损坏</option><option value="transfer">调用转出</option></select>'+
          '<input class="m-input m-mach-off-reason" placeholder="原因/地点（损坏或转出必填）" style="margin-top:4px;display:none;"></div>';
      }).join('');
      this.openModal('<div class="m-modal-header"><div class="m-modal-title">机器下线 · '+self._esc(num)+'</div><button class="m-modal-close" onclick="M.closeModal()">×</button></div>'+
        '<div class="m-form-section">'+rows+
        '<div class="m-field"><label class="m-field-label">统一原因（选填，作为损坏/转出默认原因）</label><input id="m-mach-off-globalreason" class="m-input" placeholder="如：例行回收"></div>'+
        '</div><div class="m-btn-row"><button class="m-btn m-btn-outline" onclick="M.closeModal()">取消</button><button class="m-btn m-btn-primary" onclick="M._machSubmitOffline(\''+self._esc(num)+'\')">确认下线</button></div>');
    },
    _machOffChange(sel) {
      var box = sel.parentElement && sel.parentElement.querySelector('.m-mach-off-reason');
      if (box) box.style.display = sel.value !== 'normal' ? 'block' : 'none';
    },
    async _machSubmitOffline(num) {
      var self = this;
      var D = this._machData || {};
      var globalReason = ((document.getElementById('m-mach-off-globalreason')||{}).value||'').trim();
      var acts = document.getElementsByClassName('m-mach-off-act');
      var snOps = [];
      for (var i = 0; i < acts.length; i++) {
        var sn = acts[i].getAttribute('data-sn');
        var act = acts[i].value;
        var reasonBox = acts[i].parentElement ? acts[i].parentElement.querySelector('.m-mach-off-reason') : null;
        var reason = ((reasonBox && reasonBox.value) || '').trim() || globalReason;
        var op = { snCode:sn, equipmentType:acts[i].getAttribute('data-eq')||'', handType:acts[i].getAttribute('data-hand')||'' };
        if (act === 'damaged') {
          if (!reason) { this.toast('SN '+sn+' 标记损坏需填写原因', 'err'); return; }
          op.targetStatus = 'damaged'; op.reason = reason;
        } else if (act === 'transfer') {
          if (!reason) { this.toast('SN '+sn+' 调用转出需填写地点', 'err'); return; }
          op.targetStatus = 'transferred'; op.reason = reason;
        } else { op.targetStatus = 'available'; op.reason = ''; }
        snOps.push(op);
      }

      var onlineRec = null;
      (D.machines||[]).forEach(function(m){ if (m.machineNumber === num && m.status === 'online') onlineRec = m; });
      try {
        var r = await API.syncMachineState(num, { status:'offline', deviceType: onlineRec ? (onlineRec.deviceType||'') : '', reason:globalReason, offlineType:'normal', snOperations:snOps });
        if (r && r.error) { this.toast('下线失败：'+r.error, 'err'); return; }
        this.closeModal();
        this.toast('机器 '+num+' 下线成功', 'ok');
        this.showAdminSubPage('machines');
      } catch(e) { this.toast('网络错误，请稍后重试', 'err'); }
    },

    _esc: function(s) { if(s==null)return''; return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); },
    _fmtTime: function(t) {
      if(!t)return'-';var d=new Date(t);if(isNaN(d.getTime()))return String(t);
      var diff=(Date.now()-d.getTime())/1000;
      if(diff<60)return'刚刚';if(diff<3600)return Math.floor(diff/60)+'分钟前';
      if(d.toDateString()===new Date().toDateString())return'今天 '+('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2);
      return (d.getMonth()+1)+'/'+d.getDate()+' '+('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2);
    },

    async _loadCatLabels() {
      try {
        var cfg = await API.getInventoryConfig();
        if (Array.isArray(cfg) && cfg.length) {
          var m = {};
          cfg.forEach(function(c){ if (c && c.id) m[c.id] = c.name || c.id; });
          this._catLabels = m;
          try { localStorage.setItem('gms_cat_labels', JSON.stringify(m)); } catch(e){}
        }
      } catch(e) {
        try { this._catLabels = JSON.parse(localStorage.getItem('gms_cat_labels')||'null') || undefined; } catch(e2){}
      }
    },
    _invLabel: function(t) {
      var m={glove:'wuji手套',leftGlove:'左手wuji手套',rightGlove:'右手wuji手套',dexterous:'灵巧手',leftDexterous:'左手灵巧手',rightDexterous:'右手灵巧手',gripper:'夹爪',damagedGlove:'损坏wuji手套',damagedDexterous:'损坏灵巧手',damagedGripper:'损坏夹爪',inRepairGlove:'售后wuji手套',inRepairDexterous:'售后灵巧手',inRepairGripper:'售后夹爪'};
      if (m[t]) return m[t];

      var cats = this._catLabels;
      if (cats) {
        if (cats[t]) return cats[t];
        var mm = /^(.+)_(left|right)$/.exec(String(t||''));
        if (mm && cats[mm[1]]) return cats[mm[1]] + (mm[2]==='left'?'左手':'右手');
      }
      return m[t]||t||'-';
    },
    _machineSI: function(s) {
      var m={online:{l:'在线',c:'m-badge-ok'},partial:{l:'部分在线',c:'m-badge-wrn'},offline:{l:'离线',c:'m-badge-err'}};
      return m[s]||{l:s||'-',c:'m-badge-dim'};
    },
    _ticketSI: function(s) {
      var m={pending:{l:'待响应',c:'m-badge-wrn'},open:{l:'待响应',c:'m-badge-wrn'},assigned:{l:'待响应',c:'m-badge-wrn'},responded:{l:'处理中',c:'m-badge-info'},in_progress:{l:'处理中',c:'m-badge-info'},reopened:{l:'处理中',c:'m-badge-info'},completed:{l:'已完成',c:'m-badge-ok'},resolved:{l:'已完成',c:'m-badge-ok'},closed:{l:'已关闭',c:'m-badge-dim'}};
      return m[s]||{l:s||'-',c:'m-badge-dim'};
    },
    _snSI: function(s) {
      var m={available:{l:'库存',c:'m-badge-ok'},in_use:{l:'使用中',c:'m-badge-info'},inUse:{l:'使用中',c:'m-badge-info'},damaged:{l:'已损坏',c:'m-badge-err'},in_repair:{l:'售后中',c:'m-badge-wrn'},inRepair:{l:'售后中',c:'m-badge-wrn'},transferred:{l:'已转出',c:'m-badge-dim'}};
      return m[s]||{l:s||'-',c:'m-badge-dim'};
    },
    _roleI: function(r) {
      var m={superadmin:{l:'超管',i:'S'},admin:{l:'管理员',i:'A'},user:{l:'用户',i:'U'}};
      return m[r]||{l:r||'-',i:'?'};
    }
  };

  var S = {
    stat: function(label, value) {
      return '<div class="m-stat-card"><div class="m-stat-value">'+M._esc(String(value))+'</div><div class="m-stat-label">'+M._esc(label)+'</div></div>';
    },

    sm: function(label, value) {
      return '<div class="m-stat-sm-card"><div class="m-stat-sm-value">'+M._esc(String(value))+'</div><div class="m-stat-sm-label">'+M._esc(label)+'</div></div>';
    },

    sc: function(label, value, onclick) {
      return '<div class="m-stat-sm-card" onclick="'+onclick+'" style="cursor:pointer;"><div class="m-stat-sm-value">'+M._esc(String(value))+'</div><div class="m-stat-sm-label">'+M._esc(label)+'</div></div>';
    },
    qi: function(label, fn) {
      return '<div class="m-quick-item" onclick="('+fn.toString()+')()"><div class="m-quick-icon">'+M._esc(label.charAt(0))+'</div><div class="m-quick-label">'+M._esc(label)+'</div></div>';
    },

    qj: function(label, fn) {
      return '<div class="m-quick-big-item" onclick="('+fn.toString()+')()"><div class="m-quick-big-icon">'+M._esc(label.charAt(0))+'</div><div class="m-quick-big-label">'+M._esc(label)+'</div></div>';
    },
    ai: function(label, page) {
      return '<div class="m-admin-item" onclick="M.showAdminSubPage(\''+page+'\')"><div class="m-admin-icon">'+M._esc(label.charAt(0))+'</div><div class="m-admin-label">'+M._esc(label)+'</div></div>';
    }
  };

  window.MobileApp = M;
  window.M = M;

  document.addEventListener('DOMContentLoaded', function() {
    var pw = document.getElementById('m-login-password');
    if (pw) pw.addEventListener('keydown', function(e) { if (e.key==='Enter') M.doLogin(); });
    window.addEventListener('gms_auth_error', function() {
      M.currentUser = null;
      if (M._sse) { try { M._sse.close(); } catch(e) {} M._sse = null; }
      if (_isOps) {
        location.replace('mobile.html');
        return;
      }
      M._showLogin('登录已过期，请重新登录');
    });
    M.init();
  });
})();
