// ---------- Constants ----------
const STATUS_CLASS = {
  "Requested":"st-requested","Approved":"st-approved","In Progress":"st-progress",
  "Completed":"st-completed","Closed":"st-closed","On Hold":"st-hold","Cancelled":"st-cancelled"
};
const SUPERVISOR_ONLY = ["Completed","Closed","On Hold","Cancelled"];
const ALL_STATUSES = ["Requested","Approved","In Progress","Completed","Closed","On Hold","Cancelled"];

// ---------- Supabase client ----------
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- State ----------
let allRequests = [];   // camelCase, mapped from DB rows
let allSpareParts = []; // spare parts requests, DB rows as-is (snake_case)
let role = "Staff";     // comes from the profiles table, not user-chosen
let currentUser = null;
let editingId = null;
let realtimeChannel = null;
let sparePartsChannel = null;

// ---------- DB <-> app field mapping ----------
function fromDbRow(row){
  return {
    id: row.id,
    reqNo: row.req_no,
    plate: row.plate,
    pcn: row.pcn,
    department: row.department,
    repairType: row.repair_type,
    dateRequested: row.date_requested,
    dateIn: row.date_in,
    dateOut: row.date_out,
    notes: row.notes,
    status: row.status,
    createdBy: row.created_by,
    updatedAt: row.updated_at
  };
}

function toDbInsert(r){
  return {
    req_no: r.reqNo, plate: r.plate, pcn: r.pcn, department: r.department,
    repair_type: r.repairType, date_requested: r.dateRequested,
    date_in: r.dateIn, date_out: r.dateOut, notes: r.notes,
    status: r.status, created_by: r.createdBy
  };
}

// ---------- Auth screen ----------
const authScreen = document.getElementById('authScreen');
const appShell = document.getElementById('appShell');
const authMsg = document.getElementById('authMsg');

function showAuthMsg(text, type){
  authMsg.innerHTML = `<div class="msg ${type}">${text}</div>`;
}

document.getElementById('signupBtn').addEventListener('click', async ()=>{
  const name = document.getElementById('authName').value.trim();
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  if(!email || !password){ showAuthMsg("Email and password are required.", "err"); return; }
  try{
    const { error } = await sb.auth.signUp({
      email, password,
      options: { data: { full_name: name } }
    });
    if(error){ showAuthMsg(error.message, "err"); return; }
    showAuthMsg("Account created. If email confirmation is enabled on this project, check your inbox, then log in.", "ok");
  }catch(e){
    showAuthMsg("Could not reach Supabase — check that config.js has the correct Project URL and key. (" + e.message + ")", "err");
  }
});

document.getElementById('loginBtn').addEventListener('click', async ()=>{
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  if(!email || !password){ showAuthMsg("Email and password are required.", "err"); return; }
  try{
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if(error){ showAuthMsg(error.message, "err"); return; }
  }catch(e){
    showAuthMsg("Could not reach Supabase — check that config.js has the correct Project URL and key. (" + e.message + ")", "err");
  }
});

document.getElementById('logoutBtn').addEventListener('click', async ()=>{
  await sb.auth.signOut();
});

sb.auth.onAuthStateChange((event, session)=>{
  if(session && session.user){
    currentUser = session.user;
    enterApp();
  }else{
    currentUser = null;
    exitApp();
  }
});

async function enterApp(){
  authScreen.style.display = 'none';
  appShell.style.display = 'flex';

  const { data: profile, error } = await sb
    .from('profiles')
    .select('full_name, role')
    .eq('id', currentUser.id)
    .single();

  if(error){
    console.error(error);
  }else{
    role = profile.role === 'supervisor' ? 'Supervisor' : 'Staff';
  }

  document.getElementById('userDisplay').textContent =
    (profile && profile.full_name ? profile.full_name : currentUser.email) + ' · ' + role;
  document.getElementById('formRoleBadge').textContent = role;

  await loadRequests();
  await loadSpareParts();
  subscribeRealtime();
}

function exitApp(){
  appShell.style.display = 'none';
  authScreen.style.display = 'flex';
  if(realtimeChannel){ sb.removeChannel(realtimeChannel); realtimeChannel = null; }
  if(sparePartsChannel){ sb.removeChannel(sparePartsChannel); sparePartsChannel = null; }
  allRequests = [];
  allSpareParts = [];
}

// ---------- Data loading + realtime ----------
async function loadRequests(){
  const { data, error } = await sb
    .from('maintenance_requests')
    .select('*')
    .order('date_requested', { ascending: false })
    .limit(1000);
  if(error){
    document.getElementById('dashSub').textContent = "Couldn't load data: " + error.message;
    return;
  }
  allRequests = data.map(fromDbRow);
  render();
}

async function loadSpareParts(){
  const { data, error } = await sb
    .from('spare_parts_requests')
    .select('*')
    .order('date_request', { ascending: false })
    .limit(1000);
  if(error){
    document.getElementById('sparePartsMsg').innerHTML = '<div class="msg err">Could not load spare parts requests: ' + error.message + '</div>';
    return;
  }
  allSpareParts = data;
  renderSpareParts();
}

function subscribeRealtime(){
  if(realtimeChannel) sb.removeChannel(realtimeChannel);
  realtimeChannel = sb
    .channel('maintenance_requests_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'maintenance_requests' }, ()=>{
      loadRequests();
    })
    .subscribe();

  if(sparePartsChannel) sb.removeChannel(sparePartsChannel);
  sparePartsChannel = sb
    .channel('spare_parts_requests_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'spare_parts_requests' }, ()=>{
      loadSpareParts();
    })
    .subscribe();
}


// ---------- Navigation ----------
function showView(id){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.navlink').forEach(n=>n.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.querySelector('.navlink[data-view="'+id+'"]').classList.add('active');
}
document.querySelectorAll('.navlink').forEach(n=>{
  n.addEventListener('click', ()=>showView(n.dataset.view));
});

// ---------- Helpers ----------
function normalizePlate(p){
  return p.trim().toUpperCase().replace(/\s+/g,'').replace(/^([A-Z]+)-?(\d+)$/, '$1-$2');
}
function daysBetween(a, b){
  const d1 = new Date(a), d2 = new Date(b);
  return Math.round((d2-d1)/86400000);
}
function isOverdue(r){
  if(["Closed","Cancelled","Completed"].includes(r.status)) return false;
  if(r.dateOut) return false;
  if(!r.dateRequested) return false;
  return daysBetween(r.dateRequested, new Date().toISOString().slice(0,10)) > 7;
}
function shortDept(d){
  return (d||'')
    .replace(' Division','')
    .replace('Equipment Management','Equipment Mgmt.')
    .replace('Quality Assurance and Hydrology','QA & Hydrology')
    .replace('Right of Way and Legal','Right of Way & Legal');
}
function shortType(t){ return (t||'').replace(' Maintenance','').replace(' (minor jobs)',''); }

function updatePlateList(){
  const plates = [...new Set(allRequests.map(r=>r.plate).filter(Boolean))].sort();
  const list = document.getElementById('plateList');
  list.innerHTML = plates.map(p=>`<option value="${p}">`).join('');
}

// ---------- Rendering ----------
function render(){
  renderDashboard();
  renderAllRequests();
  updatePlateList();
}

function renderDashboard(){
  document.getElementById('dashSub').textContent = "Snapshot across all divisions — live";
  const open = allRequests.filter(r=>!["Closed","Cancelled"].includes(r.status));
  const inProgress = allRequests.filter(r=>r.status==="In Progress");
  const overdue = open.filter(isOverdue);
  const done = allRequests.filter(r=>r.dateIn && r.dateOut);
  const avgTurn = done.length ? (done.reduce((s,r)=>s+daysBetween(r.dateIn,r.dateOut),0)/done.length).toFixed(1) : "–";

  document.getElementById('kpiOpen').textContent = open.length;
  document.getElementById('kpiProgress').textContent = inProgress.length;
  const overdueEl = document.getElementById('kpiOverdue');
  overdueEl.textContent = overdue.length;
  overdueEl.style.color = overdue.length > 0 ? 'var(--stop)' : 'var(--navy)';
  document.getElementById('kpiTurn').textContent = avgTurn;

  const byDept = {};
  allRequests.forEach(r=>{ byDept[r.department] = (byDept[r.department]||0)+1; });
  const deptEntries = Object.entries(byDept).sort((a,b)=>b[1]-a[1]);
  const maxDept = deptEntries.length ? deptEntries[0][1] : 1;
  const deptBars = document.getElementById('deptBars');
  deptBars.innerHTML = deptEntries.length ? deptEntries.map(([name,count])=>`
    <div class="bar-row">
      <div class="name" title="${name}">${shortDept(name)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(count/maxDept*100).toFixed(0)}%"></div></div>
      <div class="val">${count}</div>
    </div>`).join('') : '<div class="empty">No data yet</div>';

  const byType = {};
  allRequests.forEach(r=>{ byType[r.repairType] = (byType[r.repairType]||0)+1; });
  const typeTotal = allRequests.length || 1;
  const colors = {"Preventive Maintenance":"var(--ok)","Corrective Maintenance":"var(--accent)","Express Maintenance (minor jobs)":"var(--wait)"};
  const rawColors = {"Preventive Maintenance":"#2f7a4f","Corrective Maintenance":"#e8590c","Express Maintenance (minor jobs)":"#a8790f"};
  const typeLegend = document.getElementById('typeLegend');
  const typeEntries = Object.entries(byType);
  typeLegend.innerHTML = typeEntries.length ? typeEntries.map(([name,count])=>`
    <div><span class="dot" style="background:${colors[name]||'var(--muted)'}"></span>${name} — ${Math.round(count/typeTotal*100)}% (${count})</div>
  `).join('') : '<div class="empty">No data yet</div>';

  const donutEl = document.getElementById('typeDonut');
  if(donutEl){
    if(!typeEntries.length){
      donutEl.innerHTML = '';
    }else{
      let offset = 0;
      const circumference = 100;
      const segments = typeEntries.map(([name,count])=>{
        const pct = (count/typeTotal*100);
        const seg = `<circle cx="21" cy="21" r="15.9" fill="transparent" stroke="${rawColors[name]||'#5c6b7a'}" stroke-width="6"
          stroke-dasharray="${pct.toFixed(2)} ${(100-pct).toFixed(2)}" stroke-dashoffset="${(100-offset+25).toFixed(2)}"></circle>`;
        offset += pct;
        return seg;
      }).join('');
      donutEl.innerHTML = `<svg width="110" height="110" viewBox="0 0 42 42">
        <circle cx="21" cy="21" r="15.9" fill="transparent" stroke="var(--line)" stroke-width="6"></circle>
        ${segments}
      </svg>`;
    }
  }

  const byPlate = {};
  allRequests.forEach(r=>{ if(r.plate) byPlate[r.plate] = (byPlate[r.plate]||0)+1; });
  const topVehicles = Object.entries(byPlate).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const topVehiclesEl = document.getElementById('topVehicles');
  topVehiclesEl.innerHTML = topVehicles.length ? topVehicles.map(([plate,count],i)=>`
    <div class="rank-row">
      <div class="rank-num">${i+1}</div>
      <div class="rank-plate">${plate}</div>
      <div class="rank-count">${count} request${count===1?'':'s'}</div>
    </div>`).join('') : '<div class="empty">No data yet</div>';

  const recent = [...allRequests].sort((a,b)=>(b.updatedAt||"").localeCompare(a.updatedAt||"")).slice(0,20);
  const recentBody = document.getElementById('recentBody');
  recentBody.innerHTML = recent.length ? recent.map(r=>`
    <tr>
      <td class="mono">${r.reqNo||''}</td><td class="mono">${r.plate||''}</td>
      <td>${shortDept(r.department)}</td><td>${shortType(r.repairType)}</td>
      <td><span class="status ${STATUS_CLASS[r.status]||''}" style="cursor:default;">${r.status||''}</span></td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty">No requests yet</td></tr>';
}

function renderAllRequests(){
  const statusF = document.getElementById('filterStatus').value;
  const deptF = document.getElementById('filterDept').value;
  let rows = allRequests.filter(r=>{
    if(statusF && r.status !== statusF) return false;
    if(deptF && r.department !== deptF) return false;
    return true;
  });
  rows = [...rows].sort((a,b)=> (isOverdue(b)?1:0) - (isOverdue(a)?1:0));
  const body = document.getElementById('allBody');
  if(!rows.length){ body.innerHTML = '<tr><td colspan="11" class="empty">No matching requests</td></tr>'; return; }
  body.innerHTML = rows.map(r=>{
    const options = ALL_STATUSES.map(s=>{
      const disabled = SUPERVISOR_ONLY.includes(s) && role !== "Supervisor";
      return `<option value="${s}" ${s===r.status?'selected':''} ${disabled?'disabled':''}>${s}${disabled?' (Supervisor)':''}</option>`;
    }).join('');
    const rowClass = isOverdue(r) ? 'overdue' : '';
    const notes = (r.notes||'').replace(/"/g,'&quot;');
    const locked = ["Closed","Cancelled"].includes(r.status) && role !== "Supervisor";
    const editCell = locked
      ? `<span title="Only Supervisors can edit a Closed or Cancelled request" style="color:var(--muted); font-size:12.5px;">Locked</span>`
      : `<button class="link-btn" onclick="openEditModal('${r.id}')">Edit</button>`;
    return `<tr class="${rowClass}">
      <td class="mono">${r.reqNo||''}</td><td class="mono">${r.plate||''}</td><td class="mono">${r.pcn||'—'}</td>
      <td>${r.department||''}</td><td>${shortType(r.repairType)}</td>
      <td>${r.dateRequested||'—'}</td><td>${r.dateIn||'—'}</td><td>${r.dateOut||'—'}</td>
      <td class="notes-cell" title="${notes}">${r.notes||'—'}</td>
      <td><select class="status ${STATUS_CLASS[r.status]||''}" data-id="${r.id}" onchange="updateStatus(this)">${options}</select></td>
      <td>${editCell}</td>
    </tr>`;
  }).join('');
}

async function updateStatus(sel){
  const id = sel.dataset.id;
  const newStatus = sel.value;
  sel.disabled = true;
  const { error } = await sb
    .from('maintenance_requests')
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq('id', id);
  if(error){
    alert("Couldn't update status — this action may require Supervisor access. (" + error.message + ")");
  }
  sel.disabled = false;
  await loadRequests();
}

document.getElementById('filterStatus').addEventListener('change', renderAllRequests);
document.getElementById('filterDept').addEventListener('change', renderAllRequests);

// ---------- New request form ----------
document.getElementById('dateRequested').valueAsDate = new Date();

document.getElementById('requestForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const msgEl = document.getElementById('formMsg');
  msgEl.innerHTML = '';

  const reqNo = document.getElementById('reqNo').value.trim();
  if(allRequests.some(r=>r.reqNo === reqNo)){
    msgEl.innerHTML = '<div class="msg err">Request No. ' + reqNo + ' already exists — use a different number.</div>';
    return;
  }

  const saveBtn = document.getElementById('saveBtn');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

  const record = {
    reqNo,
    plate: normalizePlate(document.getElementById('plate').value),
    pcn: document.getElementById('pcn').value.trim() || null,
    department: document.getElementById('dept').value,
    repairType: document.getElementById('repairType').value,
    dateRequested: document.getElementById('dateRequested').value,
    dateIn: document.getElementById('dateIn').value || null,
    dateOut: document.getElementById('dateOut').value || null,
    notes: document.getElementById('notes').value.trim() || null,
    status: "Requested",
    createdBy: currentUser.id
  };

  const { error } = await sb.from('maintenance_requests').insert(toDbInsert(record));

  if(error){
    msgEl.innerHTML = '<div class="msg err">Could not save: ' + error.message + '</div>';
  }else{
    msgEl.innerHTML = '<div class="msg ok">Saved as ' + reqNo + '.</div>';
    e.target.reset();
    document.getElementById('dateRequested').valueAsDate = new Date();
    await loadRequests();
    setTimeout(()=>showView('requests'), 600);
  }
  saveBtn.disabled = false; saveBtn.textContent = 'Save Request';
});

// ---------- Edit modal ----------
function openEditModal(id){
  const r = allRequests.find(x=>x.id===id);
  if(!r) return;
  if(["Closed","Cancelled"].includes(r.status) && role !== "Supervisor"){
    alert("Only Supervisors can edit a Closed or Cancelled request.");
    return;
  }
  editingId = id;
  document.getElementById('editMsg').innerHTML = '';
  document.getElementById('editReqNo').value = r.reqNo || '';
  document.getElementById('editPlate').value = r.plate || '';
  document.getElementById('editPcn').value = r.pcn || '';
  document.getElementById('editDept').value = r.department || '';
  document.getElementById('editRepairType').value = r.repairType || '';
  document.getElementById('editDateRequested').value = r.dateRequested || '';
  document.getElementById('editDateIn').value = r.dateIn || '';
  document.getElementById('editDateOut').value = r.dateOut || '';
  document.getElementById('editNotes').value = r.notes || '';
  document.getElementById('editBackdrop').classList.add('active');
}

function closeEditModal(){
  editingId = null;
  document.getElementById('editBackdrop').classList.remove('active');
}

async function saveEdit(){
  if(!editingId) return;
  const current = allRequests.find(x=>x.id===editingId);
  const msgEl = document.getElementById('editMsg');
  if(current && ["Closed","Cancelled"].includes(current.status) && role !== "Supervisor"){
    msgEl.innerHTML = '<div class="msg err">Only Supervisors can edit a Closed or Cancelled request.</div>';
    return;
  }
  const btn = document.getElementById('editSaveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';

  const newReqNo = document.getElementById('editReqNo').value.trim();
  if(!newReqNo){
    msgEl.innerHTML = '<div class="msg err">Request No. cannot be empty.</div>';
    btn.disabled = false; btn.textContent = 'Save Changes';
    return;
  }
  if(allRequests.some(r=>r.reqNo === newReqNo && r.id !== editingId)){
    msgEl.innerHTML = '<div class="msg err">Request No. ' + newReqNo + ' is already used by another request.</div>';
    btn.disabled = false; btn.textContent = 'Save Changes';
    return;
  }

  const { error } = await sb.from('maintenance_requests').update({
    req_no: newReqNo,
    plate: normalizePlate(document.getElementById('editPlate').value),
    pcn: document.getElementById('editPcn').value.trim() || null,
    department: document.getElementById('editDept').value,
    repair_type: document.getElementById('editRepairType').value,
    date_requested: document.getElementById('editDateRequested').value || null,
    date_in: document.getElementById('editDateIn').value || null,
    date_out: document.getElementById('editDateOut').value || null,
    notes: document.getElementById('editNotes').value.trim() || null,
    updated_at: new Date().toISOString()
  }).eq('id', editingId);

  if(error){
    msgEl.innerHTML = '<div class="msg err">Could not save: ' + error.message + '</div>';
  }else{
    closeEditModal();
    await loadRequests();
  }
  btn.disabled = false; btn.textContent = 'Save Changes';
}

// ---------- CSV export ----------
function csvEscape(v){
  const s = (v===null||v===undefined) ? '' : String(v);
  return '"' + s.replace(/"/g,'""') + '"';
}

function exportCSV(){
  const statusF = document.getElementById('filterStatus').value;
  const deptF = document.getElementById('filterDept').value;
  const rows = allRequests.filter(r=>{
    if(statusF && r.status !== statusF) return false;
    if(deptF && r.department !== deptF) return false;
    return true;
  });
  const headers = ["Request No.","Plate","PCN","Department","Type","Date Requested","Date In","Date Out","Notes","Status"];
  const lines = [headers.map(csvEscape).join(',')];
  rows.forEach(r=>{
    lines.push([r.reqNo,r.plate,r.pcn,r.department,r.repairType,r.dateRequested,r.dateIn,r.dateOut,r.notes,r.status].map(csvEscape).join(','));
  });
  const csv = lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'maintenance-requests.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
document.getElementById('exportCsvBtn').addEventListener('click', exportCSV);

// ---------- Spare Parts Request ----------
function renderSpareParts(){
  const body = document.getElementById('sparePartsBody');
  if(!allSpareParts.length){
    body.innerHTML = '<tr><td colspan="7" class="empty">No spare parts requests yet</td></tr>';
    return;
  }
  body.innerHTML = allSpareParts.map(r=>`
    <tr>
      <td>${r.date_request||'—'}</td>
      <td class="mono">${r.plate||''}</td>
      <td class="mono">${r.dpcn||'—'}</td>
      <td>${r.department||''}</td>
      <td>${r.end_user||'—'}</td>
      <td class="notes-cell" title="${(r.requests||'').replace(/"/g,'&quot;')}">${r.requests||''}</td>
      <td class="notes-cell" title="${(r.remarks||'').replace(/"/g,'&quot;')}">${r.remarks||'—'}</td>
    </tr>`).join('');
}

document.getElementById('spDateRequest').valueAsDate = new Date();

document.getElementById('sparePartsForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const msgEl = document.getElementById('sparePartsMsg');
  msgEl.innerHTML = '';
  const btn = document.getElementById('spSaveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';

  const record = {
    plate: normalizePlate(document.getElementById('spPlate').value),
    dpcn: document.getElementById('spDpcn').value.trim() || null,
    department: document.getElementById('spDept').value,
    end_user: document.getElementById('spEndUser').value.trim() || null,
    requests: document.getElementById('spRequests').value.trim(),
    date_request: document.getElementById('spDateRequest').value,
    remarks: document.getElementById('spRemarks').value.trim() || null,
    created_by: currentUser.id
  };

  const { error } = await sb.from('spare_parts_requests').insert(record);

  if(error){
    msgEl.innerHTML = '<div class="msg err">Could not save: ' + error.message + '</div>';
  }else{
    msgEl.innerHTML = '<div class="msg ok">Spare parts request saved.</div>';
    e.target.reset();
    document.getElementById('spDateRequest').valueAsDate = new Date();
    await loadSpareParts();
  }
  btn.disabled = false; btn.textContent = 'Save Spare Parts Request';
});
