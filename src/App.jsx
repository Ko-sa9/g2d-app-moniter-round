import React, { useState, useMemo, useEffect, useRef } from 'react';
import { 
  Download, CheckCircle, AlertTriangle, Save, Search, X, ChevronRight, 
  Activity, Filter, MapPin, Monitor, Settings, User, Plus, Trash2, Edit2, 
  History, LogOut, FileText, ChevronDown, ChevronUp, ArrowRight, ArrowLeft,
  Server, Grid, Layers, Menu, BarChart2, Calendar, AlertOctagon, HelpCircle,
  Cloud, Clock, FastForward, MessageSquare, ArrowUp, ArrowDown
} from 'lucide-react';

import { initializeApp } from "firebase/app";
import { 
  getFirestore, collection, doc, setDoc, getDocs, deleteDoc, 
  query, where, onSnapshot, writeBatch, orderBy
} from "firebase/firestore";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

// ==========================================
// ★★★ ここにFirebaseの設定を貼り付けてください ★★★
const firebaseConfig = {
  apiKey: "AIzaSyDrH91q6Xl-WtSnyjlkJ19tovcvqBnIYFo",
  authDomain: "g2d-app-89646.firebaseapp.com",
  projectId: "g2d-app-89646",
  storageBucket: "g2d-app-89646.firebasestorage.app",
  messagingSenderId: "1018039229154",
  appId: "1:1018039229154:web:4a52ece7e4185b818adcbb"
};
// ==========================================

// Firebase Init
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = 'checklist-app-v1';

function App() {
  const [user, setUser] = useState(null);
  const [currentStaff, setCurrentStaff] = useState('');
  
  const [devices, setDevices] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [transmitterModels, setTransmitterModels] = useState([]);
  const [wardList, setWardList] = useState([]); // 病棟マスタ（順序保持用）
  const [records, setRecords] = useState({});

  const [selectedWard, setSelectedWard] = useState(null);
  // selectedDevice: 現在展開中（編集モード）のデバイスIDを保持
  const [selectedDevice, setSelectedDevice] = useState(null); 
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showConfirmSave, setShowConfirmSave] = useState(false);
  // const [searchTerm, setSearchTerm] = useState(''); // 削除: チェック時の検索機能は削除
  
  // 時計用のstate
  const [currentTime, setCurrentTime] = useState(new Date());

  const today = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');

  // 時計の更新
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const init = async () => {
      try {
        await signInAnonymously(auth);
      } catch (e) {
        console.error("Auth Error", e);
      }
    };
    init();
    return onAuthStateChanged(auth, setUser);
  }, []);

// Data Sync
  useEffect(() => {
    if (!user) return;
    
    // 1. Devices
    const unsubDevices = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'devices'), (snapshot) => {
      const list = snapshot.docs.map(d => d.data());
      list.sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.id.localeCompare(b.id));
      setDevices(list);
    }, (error) => console.error("Device sync error", error));

    // 2. Staff
    const unsubStaff = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'staff'), (snapshot) => {
      setStaffList(snapshot.docs.map(d => d.data()));
    }, (error) => console.error("Staff sync error", error));

    // 3. Models
    const unsubModels = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'transmitter_models'), (snapshot) => {
      setTransmitterModels(snapshot.docs.map(d => d.data()));
    }, (error) => console.error("Models sync error", error));

    // 4. Wards (病棟マスタ・順序)
    const unsubWards = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'wards'), (snapshot) => {
      const list = snapshot.docs.map(d => d.data());
      list.sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999));
      setWardList(list);
    }, (error) => console.error("Wards sync error", error));

    // 5. Checks
    const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'checks'), where('date', '==', today));
    const unsubChecks = onSnapshot(q, (snapshot) => {
      const recs = {};
      snapshot.docs.forEach(d => { recs[d.data().deviceId] = d.data(); });
      setRecords(recs);
    }, (error) => console.error("Checks sync error", error));

    return () => { unsubDevices(); unsubStaff(); unsubModels(); unsubWards(); unsubChecks(); };
  }, [user]);
  
  // --- Helpers ---
  const wards = useMemo(() => {
    const list = Array.from(new Set(devices.map(d => d.ward)));
    
    // DBのwardListがある場合はそのsortOrderを優先、なければ従来のハードコード順
    return list.sort((a, b) => {
      const wa = wardList.find(w => w.name === a);
      const wb = wardList.find(w => w.name === b);
      
      const orderA = wa ? (wa.sortOrder ?? 9999) : 9999;
      const orderB = wb ? (wb.sortOrder ?? 9999) : 9999;
      
      if (orderA !== orderB) return orderA - orderB;

      // Fallback (DB未登録時のデフォルト順)
      const defaultOrder = ['3A病棟', '4F病棟', '2F病棟', '3F透析室', '君津1FHD', '坂田HD'];
      const indexA = defaultOrder.indexOf(a);
      const indexB = defaultOrder.indexOf(b);
      if (indexA !== -1 && indexB !== -1) return indexA - indexB;
      return a.localeCompare(b);
    });
  }, [devices, wardList]);

  const filteredDevices = useMemo(() => {
    let list = devices;
    if (selectedWard) list = list.filter(d => d.ward === selectedWard);
    // 検索機能削除に伴い、ここでのフィルタリングも削除
    // if (searchTerm) list = list.filter(d => d.id.includes(searchTerm) || d.model.includes(searchTerm) || d.monitorGroup.includes(searchTerm));
    return list;
  }, [selectedWard, devices]); // searchTerm removed form dependency

  const groupedDevices = useMemo(() => {
    if (!selectedWard) return null; // searchTerm check removed
    const groups = {};
    filteredDevices.forEach(device => {
      if (!groups[device.monitorGroup]) groups[device.monitorGroup] = [];
      groups[device.monitorGroup].push(device);
    });
    return groups;
  }, [selectedWard, filteredDevices]);

  // 全体の進捗率 (病棟選択画面用)
  const totalProgress = useMemo(() => {
    if (devices.length === 0) return 0;
    const checkedCount = Object.keys(records).length;
    return Math.round((checkedCount / devices.length) * 100);
  }, [devices, records]);

  // CSV出力
  const handleDownloadCSV = (targetRecords, fileNameDate) => {
    const list = Array.isArray(targetRecords) ? targetRecords : Object.values(targetRecords);
    const header = ['点検日', '時間', '病棟', '点検者', 'モニタ', 'ch', '送信機型番', '①使用中', '②受信状態', '不良理由', '備考', '③破損', '④ch確認'];
    const rows = list.map(r => {
      const deviceMaster = devices.find(d => d.id === r.deviceId);
      const model = r.model || deviceMaster?.model || '';
      const monitor = r.monitorGroup || deviceMaster?.monitorGroup || '';
      const ward = r.ward || deviceMaster?.ward || '';
      let badReason = '';
      if (r.reception === 'BAD') {
        const reasonMap = { A: '電波切れ', B: '電極確認', C: '一時退床中', D: 'その他' };
        badReason = reasonMap[r.receptionReason || ''] || '';
        if (r.receptionReason === 'D' && r.receptionNote) badReason += `(${r.receptionNote})`;
      }
      return [
        r.date, r.timestamp.split(' ')[1] || '', ward, r.checker, monitor, r.deviceId, model,
        r.inUse === 'YES' ? '使用中' : '未使用',
        r.reception === 'GOOD' ? '良好' : (r.reception === 'BAD' ? '不良' : '-'),
        badReason, `"${r.note || ''}"`,
        r.isBroken === 'YES' ? '破損あり' : (r.isBroken === 'NO' ? 'なし' : '-'),
        r.channelCheck === 'OK' ? 'OK' : (r.channelCheck === 'NG' ? 'NG' : '-'),
      ].join(',');
    });

    const csvContent = "data:text/csv;charset=utf-8," + [header.join(','), ...rows].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `送信機点検結果_${fileNameDate}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const executeSave = () => {
    setShowConfirmSave(false);
  };

  // デバイスの展開切り替え処理
  const toggleDevice = (device) => {
    if (selectedDevice && selectedDevice.id === device.id) {
      setSelectedDevice(null); // 同じものをタップしたら閉じる
    } else {
      setSelectedDevice(device);
    }
  };

  // 保存処理 (インラインフォームから呼ばれる)
  // action: 'NEXT' | 'PREV' | 'CLOSE'
  const handleSaveRecord = async (record, action = 'CLOSE') => {
    // 修正: inUseがnull（未入力）の場合は保存をスキップする
    if (record.inUse !== null) {
        const deviceMaster = devices.find(d => d.id === record.deviceId);
        if(deviceMaster) {
            const docId = `${record.date}_${record.deviceId}`;
            const recordWithSnapshot = { 
                ...record, 
                model: deviceMaster.model, 
                monitorGroup: deviceMaster.monitorGroup, 
                ward: deviceMaster.ward 
            };
            // Firestoreに保存
            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'checks', docId), recordWithSnapshot);
        }
    }

    // ナビゲーション処理
    if (action === 'NEXT' || action === 'PREV') {
        const currentIndex = filteredDevices.findIndex(d => d.id === record.deviceId);
        
        if (action === 'NEXT') {
            if (currentIndex >= 0 && currentIndex < filteredDevices.length - 1) {
                setSelectedDevice(filteredDevices[currentIndex + 1]);
            } else {
                setSelectedDevice(null);
                // alert 削除 (修正点)
            }
        } else if (action === 'PREV') {
            if (currentIndex > 0) {
                setSelectedDevice(filteredDevices[currentIndex - 1]);
            } else {
                // 先頭の場合は維持 (alert 削除)
            }
        }
    } else {
        // CLOSE
        setSelectedDevice(null);
    }
  };

  const handleDeleteRecord = async (record) => {
    if(confirm('この点検記録を取り消しますか？\nデータは削除され「未実施」に戻ります。')) {
      const docId = `${record.date}_${record.deviceId}`;
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'checks', docId));
      // setSelectedDevice(null); // 削除後は閉じる -> 削除
    }
  };


  if (!user) return <div className="flex h-screen items-center justify-center">Loading...</div>;

  return (
    <div className="flex flex-col h-screen bg-gray-50 text-gray-800 font-sans">
      {/* Header */}
      <header className="bg-blue-600 text-white p-3 shadow-md sticky top-0 z-10">
        <div className="max-w-3xl mx-auto w-full flex flex-col gap-2">
          <div className="flex justify-between items-center">
            {/* タイトル変更: 送信機チェック -> 送信機ラウンド */}
            <h1 className="text-lg font-bold flex items-center gap-2"><Activity size={20} /> 送信機ラウンド</h1>
            <div className="flex gap-2">
              <button onClick={() => setShowHistory(true)} className="p-2 hover:bg-blue-500 rounded-full transition-colors flex items-center gap-1" title="履歴・分析">
                <BarChart2 size={20} /><span className="text-xs font-bold hidden sm:inline">履歴</span>
              </button>
              <button onClick={() => setShowSettings(true)} className="p-2 hover:bg-blue-500 rounded-full transition-colors" title="設定"><Settings size={20} /></button>
            </div>
          </div>
          
          <div className="flex gap-2">
            <div className="flex items-center gap-2 bg-blue-700 p-2 rounded-lg text-sm flex-1">
              <User size={16} className="text-blue-200" /><span className="whitespace-nowrap">点検者:</span>
              <select value={currentStaff} onChange={(e) => setCurrentStaff(e.target.value)} className="bg-blue-600 border border-blue-400 text-white rounded px-2 py-1 text-sm flex-1 focus:outline-none focus:ring-1 focus:ring-white">
                <option value="">未選択</option>
                {staffList.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
              </select>
            </div>
            {/* 日付・時計表示エリア */}
            <div className="bg-blue-800/50 p-2 rounded-lg text-xs font-mono text-blue-100 flex flex-col justify-center items-end leading-tight min-w-[120px]">
              <div>{currentTime.toLocaleDateString('ja-JP')}</div>
              <div className="text-sm font-bold">{currentTime.toLocaleTimeString('ja-JP')}</div>
            </div>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 overflow-y-auto p-4">
        <div className="max-w-3xl mx-auto w-full space-y-6">
          {!selectedWard ? (
            <div className="space-y-4 animate-fade-in">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2"><MapPin size={18} className="text-blue-600" /><h2 className="text-md font-bold text-gray-700">病棟を選択してください</h2></div>
              </div>
              
              {/* 全体の進捗率表示 (病棟選択画面のみに移動) */}
              <div className="bg-white p-3 rounded-lg shadow-sm border border-gray-100 mb-4">
                <div className="flex justify-between items-end mb-1">
                  <span className="text-xs font-bold text-gray-500">本日の点検進捗 (全体)</span>
                  <span className="font-mono text-lg font-bold text-blue-600">{totalProgress}%</span>
                </div>
                <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 transition-all duration-500 ease-out" style={{ width: `${totalProgress}%` }} />
                </div>
                <div className="text-right text-xs text-gray-400 mt-1">{Object.keys(records).length} / {devices.length} 台</div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {wards.map(ward => (
                  <button key={ward} onClick={() => setSelectedWard(ward)} className="p-4 bg-white rounded-lg shadow-sm border border-gray-200 hover:border-blue-300 hover:shadow-md transition-all active:scale-95 text-left group">
                    <span className="block text-lg font-bold text-gray-800 group-hover:text-blue-600">{ward}</span>
                    <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full mt-1 inline-block">{devices.filter(d => d.ward === ward).length}台</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4 animate-slide-up">
              <div className="flex justify-between items-center">
                <button onClick={() => setSelectedWard(null)} className="text-sm text-blue-600 hover:underline flex items-center gap-1 pl-1"><ChevronRight size={16} className="rotate-180" /> 病棟選択に戻る</button>
                <div className="text-sm font-bold bg-white px-3 py-1 rounded-full shadow-sm border text-gray-600">{selectedWard}</div>
              </div>
              {/* Search & Progress は削除されました */}
              
              {/* Device List */}
              <div className="space-y-6 pb-24">
                {groupedDevices ? (
                  Object.entries(groupedDevices).map(([groupName, groupDevices]) => (
                    <div key={groupName} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                      <div className="bg-gray-100 px-4 py-2 border-b border-gray-200 flex items-center gap-2">
                        <Monitor size={16} className="text-gray-500" /><span className="font-bold text-sm text-gray-700 font-mono">{groupName}</span>
                      </div>
                      <div className="divide-y divide-gray-100">
                        {groupDevices.map(device => (
                          <DeviceRow 
                            key={device.id} 
                            device={device} 
                            record={records[device.id]} 
                            isExpanded={selectedDevice?.id === device.id}
                            onToggle={() => toggleDevice(device)}
                            onSave={handleSaveRecord}
                            onDelete={handleDeleteRecord}
                            checker={currentStaff}
                            isFirst={filteredDevices.length > 0 && filteredDevices[0].id === device.id} // 追加
                            isLast={filteredDevices.length > 0 && filteredDevices[filteredDevices.length - 1].id === device.id} // 追加
                          />
                        ))}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden divide-y divide-gray-100">
                    {filteredDevices.map(device => (
                        <DeviceRow 
                            key={device.id} 
                            device={device} 
                            record={records[device.id]} 
                            isExpanded={selectedDevice?.id === device.id}
                            onToggle={() => toggleDevice(device)}
                            onSave={handleSaveRecord}
                            onDelete={handleDeleteRecord}
                            checker={currentStaff}
                            isFirst={filteredDevices.length > 0 && filteredDevices[0].id === device.id} // 追加
                            isLast={filteredDevices.length > 0 && filteredDevices[filteredDevices.length - 1].id === device.id} // 追加
                        />
                    ))}
                  </div>
                )}
                {filteredDevices.length === 0 && <div className="text-center py-10 text-gray-400 text-sm">該当する機器が見つかりません</div>}
              </div>
            </div>
          )}
        </div>
      </main>
      
      {/* Footer: 病棟選択画面(!selectedWard) かつ レコードが存在する場合のみ表示に変更 */}
      {Object.keys(records).length > 0 && !selectedWard && (
        <div className="bg-white p-4 border-t sticky bottom-0 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] safe-area-bottom z-10 animate-slide-up">
          <div className="max-w-3xl mx-auto flex justify-between items-center">
            <div className="flex flex-col">
              <div className="text-xs text-gray-500"><span className="font-bold text-gray-800 text-base mr-1">{Object.keys(records).length}</span>件 記録済</div>
              <div className="text-[10px] text-green-600 flex items-center gap-1 font-bold animate-pulse"><Cloud size={12}/> 自動保存済み</div>
            </div>
            <button onClick={() => setShowConfirmSave(true)} className="flex items-center gap-2 bg-blue-600 text-white px-6 py-3 rounded-lg font-bold shadow hover:bg-blue-700 active:scale-95 transition-transform">
              <CheckCircle size={20} /> 本日の点検完了
            </button>
          </div>
        </div>
      )}

      {/* モーダル表示は廃止しましたが、完了確認モーダルは残します */}
      {showConfirmSave && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-fade-in">
          <div className="bg-white w-full max-w-sm rounded-xl shadow-2xl p-6 animate-scale-in">
            <div className="flex items-center gap-2 mb-4 text-blue-600"><HelpCircle size={28}/><h3 className="text-lg font-bold">完了の確認</h3></div>
            <p className="text-gray-800 font-bold mb-2">本日の点検記録を履歴に保存しますか？</p>
            <p className="text-xs text-gray-500 mb-6 bg-gray-50 p-2 rounded">※データは都度自動保存されていますが、区切りとして記録します。</p>
            <div className="flex gap-3">
              <button onClick={() => setShowConfirmSave(false)} className="flex-1 py-3 border rounded-lg text-gray-600 hover:bg-gray-50 font-bold">キャンセル</button>
              <button onClick={executeSave} className="flex-1 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-bold shadow-md">保存する</button>
            </div>
          </div>
        </div>
      )}

      {showSettings && <SettingsModal devices={devices} staffList={staffList} transmitterModels={transmitterModels} wardList={wardList} onClose={() => setShowSettings(false)} />}
      
      {/* 修正: HistoryModalにdevicesとwardListを渡す */}
      {showHistory && <HistoryModal db={db} appId={appId} devices={devices} wardList={wardList} onClose={() => setShowHistory(false)} onDownloadCSV={handleDownloadCSV} />}
    </div>
  );
}

// --- Sub Components ---

// DeviceRow: 展開状態（isExpanded）に応じてインラインフォームを表示
function DeviceRow({ device, record, isExpanded, onToggle, onSave, onDelete, checker, isFirst, isLast }) { // isFirst, isLast 追加
  const isChecked = !!record;
  const rowRef = useRef(null);
  
  // 展開されたときに自動でスクロールして見やすくする
  useEffect(() => {
    if (isExpanded && rowRef.current) {
      setTimeout(() => {
        rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  }, [isExpanded]);

  let hasIssue = false;
  let hasNote = false;
  if (record) {
    if (record.inUse === 'YES' && record.reception === 'BAD') hasIssue = true;
    if (record.inUse === 'NO' && (record.isBroken === 'YES' || record.channelCheck === 'NG')) hasIssue = true;
    if (record.note && record.note.trim() !== '') hasNote = true;
  }

  // 優先順位: 不具合(赤) > 備考あり(オレンジ) > 正常(緑)
  let statusColorClass = 'bg-gray-50'; // 未実施
  if (isChecked) {
      if (hasIssue) statusColorClass = 'bg-red-50';
      else if (hasNote) statusColorClass = 'bg-orange-50';
      else statusColorClass = 'bg-green-50';
  }

  return (
    <div ref={rowRef} className={`transition-all ${isExpanded ? 'bg-blue-50/50 shadow-md ring-2 ring-blue-100 z-10 rounded-lg my-2' : ''}`}>
      <div 
        onClick={onToggle} 
        className={`p-4 flex justify-between items-center cursor-pointer active:bg-gray-50 
        ${!isExpanded ? statusColorClass : '!bg-transparent'}
        `}
      >
        <div>
          <div className="flex items-center gap-2">
            <span className={`text-xl font-bold font-mono ${isChecked ? (hasIssue ? 'text-red-700' : (hasNote ? 'text-orange-700' : 'text-green-700')) : 'text-gray-800'}`}>ch: {device.id}</span>
            {isChecked && !hasIssue && <CheckCircle size={18} className={hasNote ? 'text-orange-500' : 'text-green-600'} />}
            {hasIssue && <AlertTriangle size={18} className="text-red-500" />}
          </div>
          <div className="text-xs text-gray-500 mt-1 ml-1">{device.model}</div>
        </div>
        <div className="flex items-center text-gray-400">
          {isChecked ? (
            hasIssue 
              ? <span className="text-xs font-bold text-red-700 mr-2 bg-red-100 px-2 py-1 rounded border border-red-200">要確認</span>
              : <span className={`text-xs font-bold mr-2 px-2 py-1 rounded border ${hasNote ? 'text-orange-700 bg-orange-100 border-orange-200' : 'text-green-700 bg-green-100 border-green-200'}`}>{hasNote ? '備考あり' : '点検済'}</span>
          ) : (
            <span className="text-xs bg-gray-100 text-gray-500 px-2 py-1 rounded mr-2 border border-gray-200">未実施</span>
          )}
          {isExpanded ? <ChevronDown size={20} className="text-blue-500" /> : <ChevronRight size={20} />}
        </div>
      </div>

      {/* インライン入力フォームエリア */}
      {isExpanded && (
        <div className="border-t border-blue-100 p-4 bg-white rounded-b-lg animate-slide-up">
            <CheckInlineForm 
                device={device}
                initialData={record}
                checker={checker}
                onClose={onToggle}
                onSave={onSave}
                onDelete={onDelete}
                isFirst={isFirst} // 追加
                isLast={isLast}   // 追加
            />
        </div>
      )}
    </div>
  );
}

// CheckInlineForm: モーダルの中身をインライン用に調整したコンポーネント
function CheckInlineForm({ device, initialData, checker, onClose, onSave, onDelete, isFirst, isLast }) { // isFirst, isLast 追加
  const [inUse, setInUse] = useState(initialData?.inUse || null);
  const [reception, setReception] = useState(initialData?.reception || 'GOOD');
  const [receptionReason, setReceptionReason] = useState(initialData?.receptionReason || 'A');
  const [receptionNote, setReceptionNote] = useState(initialData?.receptionNote || '');
  const [isBroken, setIsBroken] = useState(initialData?.isBroken || '-');
  const [channelCheck, setChannelCheck] = useState(initialData?.channelCheck || '-');
  const [note, setNote] = useState(initialData?.note || '');

  // 追加: 外部からのデータ変更(削除含む)をフォームに反映させる
  useEffect(() => {
    setInUse(initialData?.inUse || null);
    setReception(initialData?.reception || 'GOOD');
    setReceptionReason(initialData?.receptionReason || 'A');
    setReceptionNote(initialData?.receptionNote || '');
    setIsBroken(initialData?.isBroken || '-');
    setChannelCheck(initialData?.channelCheck || '-');
    setNote(initialData?.note || '');
  }, [initialData]);

  useEffect(() => {
    if (inUse === 'YES') {
      setIsBroken('-'); setChannelCheck('-');
      if (reception === '-') setReception('GOOD');
    } else if (inUse === 'NO') {
      setReception('-');
      if (isBroken === '-') setIsBroken('NO');
      if (channelCheck === '-') setChannelCheck('OK');
    }
  }, [inUse]);

  const createRecord = () => {
    return {
      deviceId: device.id, ward: device.ward,
      date: new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-'),
      timestamp: new Date().toLocaleString('ja-JP'), checker: checker || '',
      inUse, reception: inUse === 'YES' ? reception : '-',
      receptionReason: (inUse === 'YES' && reception === 'BAD') ? receptionReason : null,
      receptionNote: (inUse === 'YES' && reception === 'BAD' && receptionReason === 'D') ? receptionNote : null,
      isBroken: inUse === 'NO' ? isBroken : '-', channelCheck: inUse === 'NO' ? channelCheck : '-',
      note
    };
  };

  const handleSave = () => {
    // 修正: inUseチェックを削除して閉じる
    onSave(createRecord(), 'CLOSE'); 
  };
  
  const handleSaveAndNext = () => {
    // 修正: 最後の要素なら何もしない
    if (isLast) return;
    // 修正: inUseチェックを削除して次へ
    onSave(createRecord(), 'NEXT'); 
  };

  const handleSaveAndPrev = () => {
    // 修正: 最初の要素なら何もしない
    if (isFirst) return;
    // 修正: inUseチェックを削除して前へ
    onSave(createRecord(), 'PREV');
  };
  
  const isSelectionRequired = inUse === null;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <label className="text-sm font-bold text-gray-700 block flex items-center gap-2"><span className="bg-blue-100 text-blue-800 w-6 h-6 rounded-full flex items-center justify-center text-xs">1</span> 使用中ですか？</label>
        <div className="grid grid-cols-2 gap-3">
          <SelectionButton label="使用中" selected={inUse === 'YES'} onClick={() => setInUse('YES')} color="blue" />
          <SelectionButton label="未使用" selected={inUse === 'NO'} onClick={() => setInUse('NO')} color="gray" />
        </div>
      </div>

      <div className={`space-y-2 transition-all ${inUse !== 'YES' ? 'hidden' : ''}`}>
        <label className="text-sm font-bold text-gray-700 block flex items-center gap-2"><span className="bg-blue-100 text-blue-800 w-6 h-6 rounded-full flex items-center justify-center text-xs">2</span> 受信状態</label>
        <div className="grid grid-cols-2 gap-3">
          <SelectionButton label="良好" selected={reception === 'GOOD'} onClick={() => setReception('GOOD')} color="green" />
          <SelectionButton label="不良" selected={reception === 'BAD'} onClick={() => setReception('BAD')} color="red" />
        </div>
        {reception === 'BAD' && (
          <div className="mt-3 bg-red-50 p-3 rounded-lg border border-red-100 space-y-2 animate-fade-in">
            <p className="text-xs font-bold text-red-700">不良の理由を選択:</p>
            <div className="grid grid-cols-1 gap-2">
              {[{ val: 'A', label: 'A: 電波切れ' }, { val: 'B', label: 'B: 電極確認' }, { val: 'C', label: 'C: 一時退床中' }, { val: 'D', label: 'D: その他' }].map(opt => (
                <label key={opt.val} className="flex items-center gap-2 p-2 bg-white rounded border cursor-pointer hover:bg-gray-50">
                  <input type="radio" name="reason" checked={receptionReason === opt.val} onChange={() => setReceptionReason(opt.val)} className="text-red-600 focus:ring-red-500" />
                  <span className="text-sm text-gray-700">{opt.label}</span>
                </label>
              ))}
            </div>
            {receptionReason === 'D' && <input type="text" placeholder="理由を記入..." value={receptionNote} onChange={(e) => setReceptionNote(e.target.value)} className="w-full p-2 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-red-300" />}
          </div>
        )}
      </div>

      <div className={`space-y-6 transition-all ${inUse !== 'NO' ? 'hidden' : ''}`}>
        <div className="space-y-2">
          <label className="text-sm font-bold text-gray-700 block flex items-center gap-2"><span className="bg-blue-100 text-blue-800 w-6 h-6 rounded-full flex items-center justify-center text-xs">3</span> 本体の破損</label>
          <div className="grid grid-cols-2 gap-3">
            <SelectionButton label="なし" selected={isBroken === 'NO'} onClick={() => setIsBroken('NO')} color="green" />
            <SelectionButton label="破損あり" selected={isBroken === 'YES'} onClick={() => setIsBroken('YES')} color="red" icon={React.createElement(AlertTriangle, {size:16})} />
          </div>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-bold text-gray-700 block flex items-center gap-2"><span className="bg-blue-100 text-blue-800 w-6 h-6 rounded-full flex items-center justify-center text-xs">4</span> ch設定確認</label>
          <div className="grid grid-cols-2 gap-3">
            <SelectionButton label="OK (合致)" selected={channelCheck === 'OK'} onClick={() => setChannelCheck('OK')} color="green" />
            <SelectionButton label="NG (不一致)" selected={channelCheck === 'NG'} onClick={() => setChannelCheck('NG')} color="red" />
          </div>
        </div>
      </div>

      <div className="space-y-2 pt-2 border-t border-dashed">
        <label className="text-sm font-bold text-gray-700 block">備考</label>
        <textarea className="w-full p-3 border rounded-lg text-sm focus:ring-2 focus:ring-blue-300 focus:border-blue-300 focus:outline-none transition-shadow bg-gray-50" rows={2} placeholder="特記事項があれば入力してください..." value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      {/* ボタン配置の変更: 左から「戻る」「取消」「次へ」 */}
      {/* 修正: grid-cols-4 -> grid-cols-3 に変更し、ボタン幅を均等化 */}
      <div className="pt-2 grid grid-cols-3 gap-3">
        {/* 戻る */}
        {/* 修正: disabled制御を変更 */}
        <button onClick={handleSaveAndPrev} disabled={isFirst} className={`col-span-1 py-4 rounded-xl flex justify-center items-center transition-all ${isFirst ? 'bg-gray-100 text-gray-300 cursor-not-allowed' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 active:scale-95'}`}>
            <ArrowLeft size={24}/>
        </button>

        {/* 取消 */}
        <div className="col-span-1">
             {initialData ? (
                /* 修正: h-full -> py-4 に変更して高さを他ボタンと厳密に合わせる */
                <button onClick={() => onDelete(initialData)} className="w-full py-4 bg-red-50 text-red-500 rounded-xl flex justify-center items-center hover:bg-red-100 active:scale-95 transition-all">
                    <Trash2 size={24} />
                </button>
            ) : (
                <div className="w-full h-full bg-gray-50 rounded-xl"></div>
            )}
        </div>
        
        {/* 次へ (メイン) */}
        {/* 修正: col-span-2 -> col-span-1 に変更して幅を均等化、disabled制御を変更 */}
        <button onClick={handleSaveAndNext} disabled={isLast} className={`col-span-1 py-4 rounded-xl flex justify-center items-center transition-all shadow-sm ${isLast ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-blue-500 text-white hover:bg-blue-600 active:scale-95'}`}>
            <ArrowRight size={24}/>
        </button>
      </div>
    </div>
  );
}

function SelectionButton({ label, selected, onClick, color, icon }) {
  const baseStyle = "py-3.5 rounded-xl font-bold text-sm transition-all border flex justify-center items-center gap-2 relative overflow-hidden";
  let colorStyle = "";
  if (selected) {
    if (color === 'blue') colorStyle = "bg-blue-50 border-blue-500 text-blue-700 shadow-sm";
    else if (color === 'green') colorStyle = "bg-green-50 border-green-500 text-green-700 shadow-sm";
    else if (color === 'red') colorStyle = "bg-red-50 border-red-500 text-red-700 shadow-sm";
    else colorStyle = "bg-gray-100 border-gray-500 text-gray-700 shadow-sm";
  } else {
    colorStyle = "bg-white border-gray-200 text-gray-500 hover:bg-gray-50 hover:border-gray-300";
  }
  return (
    <button onClick={onClick} className={`${baseStyle} ${colorStyle}`}>
      {icon && React.isValidElement(icon) ? icon : null}
      {label}
      {selected && <div className="absolute top-1 right-1"><CheckCircle size={14} className="text-current opacity-50" /></div>}
    </button>
  );
}

// --------------------------------------------------------------------------------------
// SettingsModal (Complete)
// --------------------------------------------------------------------------------------
function SettingsModal({ devices, staffList, transmitterModels, wardList, onClose }) {
  const [activeTab, setActiveTab] = useState('DEVICE');
  
  const handleSaveDevice = async (device) => {
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'devices', device.id), device);
  };
  const handleDeleteDevice = async (id) => {
    if(confirm('本当に削除しますか？')) await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'devices', id));
  };

  const handleSaveStaff = async (staff) => {
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'staff', staff.id), staff);
  };
  const handleDeleteStaff = async (id) => {
    if(confirm('本当に削除しますか？')) await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'staff', id));
  };

  const handleSaveModel = async (model) => {
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'transmitter_models', model.id), model);
  };
  const handleDeleteModel = async (id) => {
    if(confirm('本当に削除しますか？')) await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'transmitter_models', id));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white w-full max-w-2xl h-[80vh] rounded-xl shadow-2xl overflow-hidden flex flex-col">
        <div className="bg-gray-800 text-white p-4 flex justify-between items-center">
          <h2 className="text-lg font-bold flex items-center gap-2"><Settings size={20}/> 設定・マスタ管理</h2>
          <button onClick={onClose}><X size={20}/></button>
        </div>
        
        <div className="flex border-b overflow-x-auto">
          <button onClick={() => setActiveTab('DEVICE')} className={`flex-1 py-3 px-4 font-bold whitespace-nowrap ${activeTab === 'DEVICE' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500'}`}>機器マスタ</button>
          <button onClick={() => setActiveTab('STAFF')} className={`flex-1 py-3 px-4 font-bold whitespace-nowrap ${activeTab === 'STAFF' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500'}`}>担当者マスタ</button>
          <button onClick={() => setActiveTab('MODEL')} className={`flex-1 py-3 px-4 font-bold whitespace-nowrap ${activeTab === 'MODEL' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500'}`}>型番マスタ</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 bg-gray-50">
          {activeTab === 'DEVICE' ? (
            <DeviceMasterEditor list={devices} models={transmitterModels} wardList={wardList} onSave={handleSaveDevice} onDelete={handleDeleteDevice} />
          ) : activeTab === 'STAFF' ? (
            <StaffMasterEditor list={staffList} onSave={handleSaveStaff} onDelete={handleDeleteStaff} />
          ) : (
            <TransmitterModelEditor list={transmitterModels} onSave={handleSaveModel} onDelete={handleDeleteModel} />
          )}
        </div>
      </div>
    </div>
  );
}

// DeviceMasterEditor (With DnD, Monitor Edit, Bulk Add)
function DeviceMasterEditor({ list, models, wardList, onSave, onDelete }) {
  const [addMode, setAddMode] = useState(null);
  const [addStep, setAddStep] = useState(1);
  const [newDeviceBase, setNewDeviceBase] = useState({ ward: '', monitorGroup: '' });
  const [deviceRows, setDeviceRows] = useState([{id: '', model: ''}]);
  const [monitorMode, setMonitorMode] = useState('EXISTING');
  const [newMonitorModel, setNewMonitorModel] = useState('');
  const [newMonitorSerial, setNewMonitorSerial] = useState('');
  const [editItem, setEditItem] = useState(null);
  const [originalId, setOriginalId] = useState('');
  const [filterText, setFilterText] = useState('');
  const [editingMonitor, setEditingMonitor] = useState(null);
  const [draggedItem, setDraggedItem] = useState(null);
  const [expandedWards, setExpandedWards] = useState({});

  // Ward DnD State
  const [draggedWard, setDraggedWard] = useState(null);

  const transmitterModelsList = useMemo(() => models.filter(m => m.type === 'TRANSMITTER'), [models]);
  const monitorModelsList = useMemo(() => models.filter(m => m.type === 'MONITOR'), [models]);

  useEffect(() => {
    if (transmitterModelsList.length > 0) {
      setDeviceRows(prev => prev.map(row => row.model ? row : { ...row, model: transmitterModelsList[0].name }));
    }
  }, [transmitterModelsList]);

  const displayList = useMemo(() => {
    let sorted = [...list].sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999));
    if (!filterText) return sorted;
    return sorted.filter((d) => d.id.includes(filterText) || d.monitorGroup.includes(filterText) || d.ward.includes(filterText));
  }, [list, filterText]);

  const allWards = useMemo(() => Array.from(new Set(list.map((d) => d.ward))), [list]);

  const getMonitorsByWard = (ward) => {
    const wardDevices = list.filter((d) => d.ward === ward);
    return Array.from(new Set(wardDevices.map((d) => d.monitorGroup))).filter(Boolean);
  };

  const toggleWard = (ward) => setExpandedWards(prev => ({ ...prev, [ward]: !prev[ward] }));

  const startFlow = (mode) => {
    setNewDeviceBase({ ward: '', monitorGroup: '' });
    const defaultModel = transmitterModelsList.length > 0 ? transmitterModelsList[0].name : '';
    setDeviceRows([{id: '', model: defaultModel}]); 
    setMonitorMode('EXISTING');
    setNewMonitorModel(monitorModelsList.length > 0 ? monitorModelsList[0].name : '');
    setNewMonitorSerial('');
    setAddMode(mode);
    if (mode === 'WARD') { setAddStep(1); } 
    else if (mode === 'MONITOR') { setAddStep(1); setMonitorMode('NEW'); } 
    else if (mode === 'DEVICE') { setAddStep(1); setMonitorMode('EXISTING'); }
  };

  const handleNextStep = () => {
    if (addStep === 1 && !newDeviceBase.ward) return alert('病棟を選択または入力してください');
    if (addStep === 2) {
      if (monitorMode === 'EXISTING' && !newDeviceBase.monitorGroup) return alert('モニタを選択してください');
      if (monitorMode === 'NEW') {
        if (!newMonitorModel || !newMonitorSerial) return alert('モニタ型番と製造番号を入力してください');
        const groupName = `${newMonitorModel} (${newMonitorSerial})`;
        setNewDeviceBase(prev => ({ ...prev, monitorGroup: groupName }));
      }
    }
    setAddStep(prev => prev + 1);
  };

  const addRow = () => {
    const lastModel = deviceRows[deviceRows.length - 1]?.model || (transmitterModelsList.length > 0 ? transmitterModelsList[0].name : '');
    setDeviceRows([...deviceRows, {id: '', model: lastModel}]);
  };
  
  const removeRow = (index) => {
    if (deviceRows.length <= 1) return;
    setDeviceRows(deviceRows.filter((_, i) => i !== index));
  };

  const updateRow = (index, field, value) => {
    const newRows = [...deviceRows];
    newRows[index][field] = value;
    setDeviceRows(newRows);
  };

  const handleCompleteAdd = async () => {
    const validRows = deviceRows.filter(r => r.id.trim() !== '');
    if (validRows.length === 0) return alert('chを1つ以上入力してください');
    let currentMaxSort = list.length > 0 ? Math.max(...list.map((d) => d.sortOrder || 0)) : 0;
    for (const row of validRows) {
      currentMaxSort++;
      const newDevice = { ...newDeviceBase, id: row.id, model: row.model, sortOrder: currentMaxSort };
      await onSave(newDevice);
    }
    alert(`${validRows.length}件の送信機を登録しました`);
    setAddMode(null);
  };

  const handleStartEdit = (device) => { setEditItem({ ...device }); setOriginalId(device.id); };
  const handleUpdate = async () => {
    if (editItem) {
      if (editItem.id !== originalId) { await onSave(editItem); await onDelete(originalId); } 
      else { await onSave(editItem); }
      setEditItem(null); setOriginalId('');
    }
  };

  const handleUpdateMonitorName = async () => {
    if (!editingMonitor || !editingMonitor.model || !editingMonitor.serial) return;
    const newName = `${editingMonitor.model} (${editingMonitor.serial})`;
    if (newName === editingMonitor.oldName) { setEditingMonitor(null); return; }
    if (!confirm(`「${editingMonitor.oldName}」を「${newName}」に変更します。\n紐付いている全ての送信機データが更新されますがよろしいですか？`)) return;
    const batch = writeBatch(db);
    const targets = list.filter((d) => d.monitorGroup === editingMonitor.oldName);
    targets.forEach((d) => { batch.update(doc(db, 'artifacts', appId, 'public', 'data', 'devices', d.id), { monitorGroup: newName }); });
    await batch.commit();
    setEditingMonitor(null);
  };

  // --- Device DnD Handlers ---
  const handleDragStart = (e, item) => { 
    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) {
      e.preventDefault();
      return;
    }
    setDraggedItem(item); 
    if ('dataTransfer' in e) e.dataTransfer.effectAllowed = 'move'; 
  };
  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const handleDrop = async (e, targetItem) => {
    e.preventDefault();
    if (!draggedItem || draggedItem.id === targetItem.id) return;
    if (draggedItem.monitorGroup !== targetItem.monitorGroup) return;
    const batch = writeBatch(db);
    const draggedOrder = draggedItem.sortOrder ?? 0;
    const targetOrder = targetItem.sortOrder ?? 0;
    batch.update(doc(db, 'artifacts', appId, 'public', 'data', 'devices', draggedItem.id), { sortOrder: targetOrder });
    batch.update(doc(db, 'artifacts', appId, 'public', 'data', 'devices', targetItem.id), { sortOrder: draggedOrder });
    await batch.commit();
    setDraggedItem(null);
  };

  // --- Ward DnD Handlers ---
  const handleWardDragStart = (e, ward) => {
    // ボタン等でのドラッグ開始を防止
    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) {
      // ただし、ドラッグハンドルの場合は許可するなどの制御が必要だが、
      // ここではヘッダー全体をドラッグ可能とし、展開ボタン等は stopPropagation する
    }
    setDraggedWard(ward);
    if ('dataTransfer' in e) e.dataTransfer.effectAllowed = 'move'; 
  };
  
  const handleWardDrop = async (e, targetWardName) => {
    e.preventDefault();
    if (!draggedWard || draggedWard === targetWardName) return;

    // 現在の表示順（ソート済み）を取得
    const currentOrder = sortedWards;
    const fromIndex = currentOrder.indexOf(draggedWard);
    const toIndex = currentOrder.indexOf(targetWardName);
    
    if (fromIndex === -1 || toIndex === -1) return;

    // 配列を並び替え
    const newOrder = [...currentOrder];
    newOrder.splice(fromIndex, 1);
    newOrder.splice(toIndex, 0, draggedWard);

    // Firestoreに保存 (全病棟の順序を更新)
    const batch = writeBatch(db);
    newOrder.forEach((wardName, index) => {
      batch.set(doc(db, 'artifacts', appId, 'public', 'data', 'wards', wardName), {
        name: wardName,
        sortOrder: index + 1
      });
    });
    
    await batch.commit();
    setDraggedWard(null);
  };
  
  const touchItemRef = useRef(null);
  const handleTouchStart = (e, item) => { touchItemRef.current = item; };
  const handleTouchMove = (e) => {};
  const handleTouchEnd = async (e) => {
    const changedTouch = e.changedTouches[0];
    const elem = document.elementFromPoint(changedTouch.clientX, changedTouch.clientY);
    const targetRow = elem?.closest('[data-device-id]');
    if (targetRow && touchItemRef.current) {
      const targetId = targetRow.getAttribute('data-device-id');
      if (targetId && targetId !== touchItemRef.current.id) {
        const targetDevice = list.find((d) => d.id === targetId);
        if (targetDevice) await handleDrop({ preventDefault: () => {} }, targetDevice);
      }
    }
    touchItemRef.current = null;
  };
  
  const devicesByWardAndMonitor = useMemo(() => {
    const wardGroups = {};
    displayList.forEach((d) => {
      if (!wardGroups[d.ward]) wardGroups[d.ward] = {};
      if (!wardGroups[d.ward][d.monitorGroup]) wardGroups[d.ward][d.monitorGroup] = [];
      wardGroups[d.ward][d.monitorGroup].push(d);
    });
    return wardGroups;
  }, [displayList]);

  // 病棟の表示順を決定
  const sortedWards = useMemo(() => {
    const presentWards = Object.keys(devicesByWardAndMonitor);
    return presentWards.sort((a, b) => {
      const wa = wardList.find(w => w.name === a);
      const wb = wardList.find(w => w.name === b);
      
      const orderA = wa ? (wa.sortOrder ?? 9999) : 9999;
      const orderB = wb ? (wb.sortOrder ?? 9999) : 9999;
      
      if (orderA !== orderB) return orderA - orderB;
      return a.localeCompare(b);
    });
  }, [devicesByWardAndMonitor, wardList]);

  if (addMode) {
    return (
      <div className="bg-white p-6 rounded-lg shadow-lg border border-gray-200">
        <div className="flex items-center gap-2 mb-4 pb-2 border-b">
          <h3 className="text-xl font-bold">{addMode === 'WARD' ? '新規病棟の開設' : addMode === 'MONITOR' ? '新規モニタの追加' : '送信機の追加'} <span className="text-sm font-normal text-gray-500 ml-2">(Step {addStep}/3)</span></h3>
        </div>
        {addStep === 1 && (
          <div className="space-y-4 animate-fade-in">
            <h4 className="font-bold text-gray-700">{addMode === 'WARD' ? '1. 新しい病棟名を入力してください' : '1. 対象の病棟を選択してください'}</h4>
            {addMode !== 'WARD' && (
              <div className="grid grid-cols-2 gap-2 max-h-40 overflow-y-auto">
                {allWards.map(ward => <button key={ward} onClick={() => setNewDeviceBase({...newDeviceBase, ward})} className={`p-3 rounded border text-left ${newDeviceBase.ward === ward ? 'bg-blue-100 border-blue-500 text-blue-800 font-bold' : 'bg-white hover:bg-gray-50'}`}>{ward}</button>)}
              </div>
            )}
            {(addMode === 'WARD') && (
              <div className="mt-4"><label className="text-xs text-gray-500 block mb-1">病棟名:</label><input className="w-full border p-2 rounded" placeholder="新しい病棟名..." value={newDeviceBase.ward} onChange={e => setNewDeviceBase({...newDeviceBase, ward: e.target.value})} autoFocus/></div>
            )}
          </div>
        )}
        {addStep === 2 && (
          <div className="space-y-4 animate-fade-in">
            <h4 className="font-bold text-gray-700">{addMode === 'MONITOR' ? '2. 新しいモニタ情報を入力してください' : '2. モニタ(親機)を選択してください'}</h4>
            <p className="text-sm text-gray-500 mb-2">選択中の病棟: {newDeviceBase.ward}</p>
            {addMode !== 'MONITOR' && (
              <div className="flex bg-gray-100 p-1 rounded-lg mb-4">
                <button onClick={() => setMonitorMode('EXISTING')} className={`flex-1 py-2 rounded-md text-sm font-bold transition-all ${monitorMode === 'EXISTING' ? 'bg-white shadow text-blue-600' : 'text-gray-500'}`}>既存から選択</button>
                <button onClick={() => setMonitorMode('NEW')} className={`flex-1 py-2 rounded-md text-sm font-bold transition-all ${monitorMode === 'NEW' ? 'bg-white shadow text-blue-600' : 'text-gray-500'}`}>新規作成</button>
              </div>
            )}
            {monitorMode === 'EXISTING' && addMode !== 'MONITOR' && (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {getMonitorsByWard(newDeviceBase.ward).map(monitor => (
                  <button key={monitor} onClick={() => setNewDeviceBase({...newDeviceBase, monitorGroup: monitor})} className={`w-full p-3 rounded border text-left flex items-center gap-2 ${newDeviceBase.monitorGroup === monitor ? 'bg-blue-100 border-blue-500 text-blue-800 font-bold' : 'bg-white hover:bg-gray-50'}`}><Monitor size={16}/> {monitor}</button>
                ))}
                {getMonitorsByWard(newDeviceBase.ward).length === 0 && <div className="text-center py-8 text-gray-400 bg-gray-50 rounded border border-dashed">この病棟にはまだモニタがありません。<br/>新規作成してください。</div>}
              </div>
            )}
            {monitorMode === 'NEW' && (
              <div className="bg-gray-50 p-4 rounded border space-y-4 animate-slide-up">
                <div className="grid grid-cols-2 gap-4">
                  <div><label className="block text-xs font-bold text-gray-700 mb-1">モニタ型番</label><select className="w-full border p-2 rounded" value={newMonitorModel} onChange={e => setNewMonitorModel(e.target.value)}><option value="">選択してください</option>{monitorModelsList.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}</select></div>
                  <div><label className="block text-xs font-bold text-gray-700 mb-1">製造番号</label><input className="w-full border p-2 rounded" placeholder="例: 01677" value={newMonitorSerial} onChange={e => setNewMonitorSerial(e.target.value)}/></div>
                </div>
              </div>
            )}
          </div>
        )}
        {addStep === 3 && (
          <div className="space-y-4 animate-fade-in">
            <h4 className="font-bold text-gray-700">3. 送信機(ch)を入力して登録完了</h4>
            <div className="bg-blue-50 p-4 rounded-lg text-sm text-blue-800 mb-4 border border-blue-100"><p className="font-bold mb-1">確認:</p><ul className="list-disc pl-5 space-y-1"><li>病棟: {newDeviceBase.ward}</li><li>モニタ: {newDeviceBase.monitorGroup}</li></ul></div>
            <div className="space-y-3">
              <div className="grid grid-cols-12 gap-2 text-xs font-bold text-gray-500 px-1"><div className="col-span-6">ch (管理番号)</div><div className="col-span-5">型番</div><div className="col-span-1"></div></div>
              {deviceRows.map((row, index) => (
                <div key={index} className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-6"><input className="w-full border p-2 rounded font-mono" placeholder="例: 1001" value={row.id} onChange={e => updateRow(index, 'id', e.target.value)} autoFocus={index === deviceRows.length - 1}/></div>
                  <div className="col-span-5"><select className="w-full border p-2 rounded" value={row.model} onChange={e => updateRow(index, 'model', e.target.value)}>{transmitterModelsList.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}</select></div>
                  <div className="col-span-1 flex justify-center">{deviceRows.length > 1 && <button onClick={() => removeRow(index)} className="text-red-400 hover:text-red-600 p-1"><Trash2 size={18}/></button>}</div>
                </div>
              ))}
              <button onClick={addRow} className="w-full py-2 border-2 border-dashed border-gray-300 rounded-lg text-gray-500 hover:border-blue-400 hover:text-blue-500 hover:bg-blue-50 transition-colors flex items-center justify-center gap-2"><Plus size={16}/> 機器を追加</button>
            </div>
          </div>
        )}
        <div className="flex justify-between mt-8 pt-4 border-t">
           {addStep > 1 ? <button onClick={() => setAddStep(s => s - 1)} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded flex items-center gap-1"><ArrowLeft size={16}/> 戻る</button> : <button onClick={() => setAddMode(null)} className="px-4 py-2 text-gray-500 hover:bg-gray-100 rounded">キャンセル</button>}
           {addStep < 3 ? <button onClick={handleNextStep} className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center gap-1">次へ <ArrowRight size={16}/></button> : <button onClick={handleCompleteAdd} className="px-6 py-2 bg-green-600 text-white rounded hover:bg-green-700 flex items-center gap-1 font-bold"><Save size={16}/> 登録完了</button>}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 mb-6">
        <button onClick={() => startFlow('WARD')} className="flex flex-col items-center justify-center p-4 bg-white border-2 border-dashed border-gray-300 rounded-xl hover:border-blue-500 hover:bg-blue-50 transition-all group"><div className="bg-blue-100 p-3 rounded-full mb-2 group-hover:bg-blue-200 group-hover:scale-110 transition-transform"><MapPin size={24} className="text-blue-600"/></div><span className="text-sm font-bold text-gray-700">病棟を追加</span></button>
        <button onClick={() => startFlow('MONITOR')} className="flex flex-col items-center justify-center p-4 bg-white border-2 border-dashed border-gray-300 rounded-xl hover:border-green-500 hover:bg-green-50 transition-all group"><div className="bg-green-100 p-3 rounded-full mb-2 group-hover:bg-green-200 group-hover:scale-110 transition-transform"><Monitor size={24} className="text-green-600"/></div><span className="text-sm font-bold text-gray-700">モニタを追加</span></button>
        <button onClick={() => startFlow('DEVICE')} className="flex flex-col items-center justify-center p-4 bg-white border-2 border-dashed border-gray-300 rounded-xl hover:border-orange-500 hover:bg-orange-50 transition-all group"><div className="bg-orange-100 p-3 rounded-full mb-2 group-hover:bg-orange-200 group-hover:scale-110 transition-transform"><Activity size={24} className="text-orange-600"/></div><span className="text-sm font-bold text-gray-700">送信機を追加</span></button>
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-2.5 text-gray-400" size={18} />
        <input type="text" placeholder="機器マスタ内検索..." value={filterText} onChange={(e) => setFilterText(e.target.value)} className="w-full pl-10 pr-4 py-2 bg-white border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-300 text-sm" />
        {filterText && <button onClick={() => setFilterText('')} className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600"><X size={18}/></button>}
      </div>

      {editItem && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
          <div className="bg-white p-6 rounded-lg shadow-xl w-full max-w-md border">
            <h3 className="font-bold mb-4">機器情報の編集</h3>
            <div className="space-y-3">
               <div><label className="text-xs text-gray-500">ch</label><input className="w-full border p-2 rounded bg-white" value={editItem.id} onChange={e => setEditItem({...editItem, id: e.target.value})}/></div>
               <div><label className="text-xs text-gray-500">病棟</label><input className="w-full border p-2 rounded bg-gray-100 text-gray-500" value={editItem.ward} disabled/></div>
               <div><label className="text-xs text-gray-500">モニタ</label><input className="w-full border p-2 rounded bg-gray-100 text-gray-500" value={editItem.monitorGroup} disabled/></div>
               <div><label className="text-xs text-gray-500">型番</label><select className="w-full border p-2 rounded" value={editItem.model} onChange={e => setEditItem({...editItem, model: e.target.value})}>{transmitterModelsList.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}</select></div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
               <button onClick={() => setEditItem(null)} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded">キャンセル</button>
               <button onClick={handleUpdate} className="px-4 py-2 bg-blue-600 text-white rounded font-bold">更新</button>
            </div>
          </div>
        </div>
      )}

      {editingMonitor && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
          <div className="bg-white p-6 rounded-lg shadow-xl w-full max-w-md border">
            <h3 className="font-bold mb-4 flex items-center gap-2"><Edit2 size={20}/> モニタ情報の編集</h3>
            <div className="grid grid-cols-2 gap-4">
              <div><label className="block text-xs font-bold text-gray-700 mb-1">モニタ型番</label><select className="w-full border p-2 rounded" value={editingMonitor.model} onChange={e => setEditingMonitor({...editingMonitor, model: e.target.value})}>{monitorModelsList.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}</select></div>
              <div><label className="block text-xs font-bold text-gray-700 mb-1">製造番号</label><input className="w-full border p-2 rounded" value={editingMonitor.serial} onChange={e => setEditingMonitor({...editingMonitor, serial: e.target.value})}/></div>
            </div>
            <div className="mt-4 text-center"><div className="text-xs text-gray-400 mb-1">更新後の名前</div><div className="font-mono bg-gray-100 border px-3 py-1 rounded inline-block">{editingMonitor.model} ({editingMonitor.serial})</div></div>
            <div className="flex justify-end gap-2 mt-6">
               <button onClick={() => setEditingMonitor(null)} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded">キャンセル</button>
               <button onClick={handleUpdateMonitorName} className="px-4 py-2 bg-blue-600 text-white rounded font-bold">一括更新</button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {/* 病棟ごとのリスト (並び替え対応) */}
        {sortedWards.map((ward) => {
          const monitorGroups = devicesByWardAndMonitor[ward];
          return (
            <div 
              key={ward} 
              className="border rounded-lg bg-white overflow-hidden shadow-sm transition-all"
              draggable="true"
              onDragStart={(e) => handleWardDragStart(e, ward)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleWardDrop(e, ward)}
            >
              <div className="w-full p-3 bg-gray-50 flex justify-between items-center hover:bg-gray-100 transition-colors cursor-move relative group">
                {/* ドラッグハンドル（視覚的） */}
                <div className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity"><Menu size={14}/></div>
                
                <button onClick={(e) => { e.stopPropagation(); toggleWard(ward); }} className="flex-1 flex justify-between items-center pl-6">
                  <div className="flex items-center gap-2"><MapPin size={18} className="text-blue-500"/><span className="font-bold text-gray-800">{ward}</span></div>
                  {expandedWards[ward] ? <ChevronUp size={20} className="text-gray-400"/> : <ChevronDown size={20} className="text-gray-400"/>}
                </button>
              </div>
              
              {expandedWards[ward] && (
                <div className="p-3 bg-white space-y-4 animate-slide-up">
                  {Object.entries(monitorGroups).map(([monitorName, monitorDevices]) => (
                    <div key={monitorName} className="border rounded-md overflow-hidden">
                      <div className="bg-gray-100 px-3 py-2 flex items-center justify-between">
                        <div className="flex items-center gap-2 text-sm font-bold text-gray-700"><Monitor size={14} className="text-green-600"/>{monitorName}</div>
                        <button onClick={() => { const match = monitorName.match(/^(.+)\s\((.+)\)$/); setEditingMonitor({ oldName: monitorName, model: match ? match[1] : monitorName, serial: match ? match[2] : '' }); }} className="text-xs flex items-center gap-1 bg-white border px-2 py-1 rounded hover:bg-blue-50 text-blue-600 transition-colors"><Edit2 size={12}/> 編集</button>
                      </div>
                      <div className="divide-y divide-gray-100 relative">
                        {monitorDevices.map(d => (
                          <div 
                            key={d.id} 
                            data-device-id={d.id} 
                            className="p-2 flex justify-between items-center bg-white cursor-move active:bg-blue-50 active:opacity-80"
                            draggable="true" 
                            onDragStart={(e) => handleDragStart(e, d)} 
                            onDragOver={handleDragOver} 
                            onDrop={(e) => handleDrop(e, d)} 
                            onTouchStart={(e) => handleTouchStart(e, d)} 
                            onTouchMove={handleTouchMove} 
                            onTouchEnd={handleTouchEnd}
                          >
                            <div className="flex items-center gap-2 pointer-events-none">
                              <div className="p-2 text-gray-400"><Menu size={16}/></div>
                              <span className="font-bold font-mono text-gray-800 w-16 text-right">ch:{d.id}</span>
                              <span className="text-xs text-gray-400">({d.model})</span>
                            </div>
                            <div className="flex items-center gap-2">
                              {/* ボタンでのドラッグ発火防止は handleDragStart で制御済み */}
                              <button onClick={() => handleStartEdit(d)} className="p-1.5 text-blue-500 hover:bg-blue-50 rounded transition-colors"><Edit2 size={16}/></button>
                              <button onClick={() => onDelete(d.id)} className="p-1.5 text-red-500 hover:bg-red-50 rounded transition-colors"><Trash2 size={16}/></button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// StaffMasterEditor
function StaffMasterEditor({ list, onSave, onDelete }) {
  const [formData, setFormData] = useState({ id: '', name: '' });
  const [editItem, setEditItem] = useState(null);

  useEffect(() => {
    if (editItem) setFormData(editItem);
    else setFormData({ id: crypto.randomUUID(), name: '' });
  }, [editItem]);

  return (
    <div className="space-y-4">
      <div className="bg-white p-4 rounded shadow space-y-3">
        <h3 className="font-bold text-gray-700">{editItem ? 'スタッフ編集' : '新規追加'}</h3>
        <div className="flex gap-2">
          <input className="border p-2 rounded flex-1" placeholder="氏名" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} />
          {editItem && <button onClick={() => setEditItem(null)} className="px-3 py-1 bg-gray-300 rounded">キャンセル</button>}
          <button disabled={!formData.name} onClick={() => { onSave(formData); setFormData({id: crypto.randomUUID(), name:''}); setEditItem(null); }} className="px-3 py-1 bg-blue-600 text-white rounded flex items-center gap-1"><Save size={16}/> 保存</button>
        </div>
      </div>
      <div className="space-y-2">
        {list.map(s => (
          <div key={s.id} className="bg-white p-3 rounded shadow flex justify-between items-center">
            <span className="font-bold">{s.name}</span>
            <div className="flex gap-2">
              <button onClick={() => setEditItem(s)} className="text-blue-500 hover:bg-blue-50 p-1 rounded"><Edit2 size={18}/></button>
              <button onClick={() => onDelete(s.id)} className="text-red-500 hover:bg-red-50 p-1 rounded"><Trash2 size={18}/></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// TransmitterModelEditor
function TransmitterModelEditor({ list, onSave, onDelete }) {
  const [formData, setFormData] = useState({ id: '', name: '', type: 'TRANSMITTER' });
  const [editItem, setEditItem] = useState(null);

  useEffect(() => {
    if (editItem) setFormData(editItem);
    else setFormData({ id: '', name: '', type: 'TRANSMITTER' });
  }, [editItem]);

  const handleSubmit = async () => {
    const itemToSave = editItem ? formData : { ...formData, id: formData.name }; 
    await onSave(itemToSave);
    setFormData({ id: '', name: '', type: 'TRANSMITTER' });
    setEditItem(null);
  };

  return (
    <div className="space-y-4">
      <div className="bg-white p-4 rounded shadow space-y-3">
        <h3 className="font-bold text-gray-700">{editItem ? '型番編集' : '新規追加'}</h3>
        <div className="flex gap-2 mb-2">
          <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="type" checked={formData.type === 'TRANSMITTER'} onChange={() => setFormData({...formData, type: 'TRANSMITTER'})} /> <span className="text-sm">送信機 (ZS-***)</span></label>
          <label className="flex items-center gap-2 cursor-pointer ml-4"><input type="radio" name="type" checked={formData.type === 'MONITOR'} onChange={() => setFormData({...formData, type: 'MONITOR'})} /> <span className="text-sm">モニタ (WEP-***)</span></label>
        </div>
        <div className="flex gap-2">
          <input className="border p-2 rounded flex-1" placeholder="型番名" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} />
          {editItem && <button onClick={() => setEditItem(null)} className="px-3 py-1 bg-gray-300 rounded">キャンセル</button>}
          <button disabled={!formData.name} onClick={handleSubmit} className="px-3 py-1 bg-blue-600 text-white rounded flex items-center gap-1"><Save size={16}/> 保存</button>
        </div>
      </div>
      <div className="space-y-2">
        {list.map(m => (
          <div key={m.id} className="bg-white p-3 rounded shadow flex justify-between items-center">
            <div><span className={`text-xs px-2 py-0.5 rounded mr-2 ${m.type === 'TRANSMITTER' ? 'bg-orange-100 text-orange-800' : 'bg-green-100 text-green-800'}`}>{m.type === 'TRANSMITTER' ? '送信機' : 'モニタ'}</span><span className="font-bold">{m.name}</span></div>
            <div className="flex gap-2">
              <button onClick={() => setEditItem(m)} className="text-blue-500 hover:bg-blue-50 p-1 rounded"><Edit2 size={18}/></button>
              <button onClick={() => onDelete(m.id)} className="text-red-500 hover:bg-red-50 p-1 rounded"><Trash2 size={18}/></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// 5. HistoryModal (Full Dashboard)
// 修正: devices, wardListを受け取る
function HistoryModal({ db, appId, devices, wardList, onClose, onDownloadCSV }) {
  const [historyRecords, setHistoryRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterMode, setFilterMode] = useState('ALL');
  const [searchTerm, setSearchTerm] = useState(''); // Added Search state
  
  // アコーディオン用state
  const [expandedDates, setExpandedDates] = useState({});
  const [expandedWards, setExpandedWards] = useState({});

  useEffect(() => {
    const fetchHistory = async () => {
      const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'checks'));
      const snapshot = await getDocs(q);
      const list = snapshot.docs.map(d => d.data());
      // 保存順(タイムスタンプ降順)でまずは取得
      list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setHistoryRecords(list);
      setLoading(false);
    };
    fetchHistory();
  }, [db, appId]);

  const filteredRecords = useMemo(() => {
    return historyRecords.filter(r => {
      if (filterMode === 'ISSUES') {
         if (!(r.reception === 'BAD' || r.isBroken === 'YES' || r.channelCheck === 'NG')) return false;
      }
      
      // Search Logic
      if (searchTerm) {
          const lower = searchTerm.toLowerCase();
          const match = 
            r.deviceId.toLowerCase().includes(lower) || 
            (r.ward && r.ward.toLowerCase().includes(lower)) ||
            (r.monitorGroup && r.monitorGroup.toLowerCase().includes(lower)) ||
            (r.checker && r.checker.toLowerCase().includes(lower)) ||
            (r.note && r.note.toLowerCase().includes(lower));
          if (!match) return false;
      }
      return true;
    });
  }, [historyRecords, filterMode, searchTerm]);

  const stats = useMemo(() => {
    const total = historyRecords.length;
    if (total === 0) return null;
    const inUseCount = historyRecords.filter(r => r.inUse === 'YES').length;
    const issueCount = historyRecords.filter(r => r.reception === 'BAD' || r.isBroken === 'YES' || r.channelCheck === 'NG').length;
    return { total, utilization: Math.round((inUseCount / total) * 100), issueRate: Math.round((issueCount / total) * 100), issueCount };
  }, [historyRecords]);

  // マスタ情報を使ってソート順を決定するヘルパー
  const getDeviceSortOrder = (deviceId) => {
    const d = devices.find(dev => dev.id === deviceId);
    return d ? (d.sortOrder ?? 9999) : 9999;
  };
  
  const getWardSortOrder = (wardName) => {
    const w = wardList.find(w => w.name === wardName);
    return w ? (w.sortOrder ?? 9999) : 9999;
  };

  // 履歴のグルーピングとソート (日付 > 病棟 > モニタ > 機器)
  const groupedHistory = useMemo(() => {
    const groups = {};
    
    // まず日付でまとめる
    filteredRecords.forEach(r => {
      if (!groups[r.date]) groups[r.date] = [];
      groups[r.date].push(r);
    });

    // 日付ごとにマスタ順でソート
    Object.keys(groups).forEach(date => {
      groups[date].sort((a, b) => {
         // 1. 病棟順
         const wa = getWardSortOrder(a.ward);
         const wb = getWardSortOrder(b.ward);
         if (wa !== wb) return wa - wb;
         
         // 2. モニタグループ順 (文字列比較)
         if (a.monitorGroup !== b.monitorGroup) return a.monitorGroup.localeCompare(b.monitorGroup);

         // 3. 機器順 (sortOrder)
         const da = getDeviceSortOrder(a.deviceId);
         const db = getDeviceSortOrder(b.deviceId);
         return da - db;
      });
    });

    return groups;
  }, [filteredRecords, devices, wardList]);

  // 表示用に階層化されたデータを生成する
  // 構造: { [date]: [ { ward: '...', monitors: [ { name: '...', records: [...] } ] } ] }
  const displayStructure = useMemo(() => {
      const result = {};
      Object.entries(groupedHistory).forEach(([date, records]) => {
          const wardMap = {};
          
          records.forEach(r => {
              if(!wardMap[r.ward]) wardMap[r.ward] = {};
              if(!wardMap[r.ward][r.monitorGroup]) wardMap[r.ward][r.monitorGroup] = [];
              wardMap[r.ward][r.monitorGroup].push(r);
          });
          
          // 病棟順に並べ替え
          const sortedWardKeys = Object.keys(wardMap).sort((a, b) => getWardSortOrder(a) - getWardSortOrder(b));
          
          result[date] = sortedWardKeys.map(ward => {
              const monitorMap = wardMap[ward];
              const sortedMonitors = Object.keys(monitorMap).sort(); // モニタ名は名前順
              return {
                  wardName: ward,
                  monitors: sortedMonitors.map(mon => ({
                      monitorName: mon,
                      records: monitorMap[mon] // レコードはすでにsortOrder順
                  }))
              };
          });
      });
      return result;
  }, [groupedHistory]);

  // 最新の日付を初期展開
  useEffect(() => {
    if (Object.keys(displayStructure).length > 0) {
        // キーは日付文字列（YYYY-MM-DDなど）だが、ソート順はgroupedHistory作成時に保証されていないため、念のためソートして最新を取得
        // ただし、groupedHistoryのキー取得順序はブラウザ依存もあるが、今回は日付降順で表示したい
        const sortedDates = Object.keys(displayStructure).sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
        if (sortedDates.length > 0) {
            setExpandedDates(prev => ({ ...prev, [sortedDates[0]]: true }));
        }
    }
  }, [displayStructure]); // displayStructureが変わったとき（初回ロード時含む）に実行

  // 受信不良の理由コードを日本語に変換するマップ
  const receptionReasonMap = { 
    A: '電波切れ', 
    B: '電極確認', 
    C: '一時退床中', 
    D: 'その他' 
  };

  const toggleDate = (date) => {
      setExpandedDates(prev => ({ ...prev, [date]: !prev[date] }));
  };

  const toggleWard = (date, ward) => {
      const key = `${date}_${ward}`;
      setExpandedWards(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // 日付降順でソート
  const sortedDateKeys = Object.keys(displayStructure).sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white w-full max-w-4xl h-[90vh] rounded-xl shadow-2xl overflow-hidden flex flex-col">
        <div className="bg-gray-800 text-white p-4 flex justify-between items-center">
          <h2 className="text-lg font-bold flex items-center gap-2"><BarChart2 size={20}/> 履歴・分析ダッシュボード</h2>
          <button onClick={onClose}><X size={20}/></button>
        </div>
        <div className="p-4 border-b bg-gray-50 flex flex-col gap-4">
           {/* Top Stats */}
           {stats && (
            <div className="flex gap-4 text-sm justify-end">
              <div className="bg-blue-50 px-3 py-1 rounded border border-blue-200"><span className="text-gray-500 text-xs block">稼働率</span><span className="font-bold text-lg text-blue-700">{stats.utilization}%</span></div>
              <div className="bg-red-50 px-3 py-1 rounded border border-red-200"><span className="text-gray-500 text-xs block">不具合件数</span><span className="font-bold text-lg text-red-700">{stats.issueCount}件</span></div>
            </div>
          )}
          
          <div className="flex flex-wrap gap-4 items-center justify-between">
            <div className="flex bg-white rounded-lg border p-1 shadow-sm">
                <button onClick={() => setFilterMode('ALL')} className={`px-4 py-2 rounded-md text-sm font-bold transition-all ${filterMode === 'ALL' ? 'bg-blue-100 text-blue-800' : 'text-gray-500 hover:bg-gray-100'}`}>全て表示</button>
                <button onClick={() => setFilterMode('ISSUES')} className={`px-4 py-2 rounded-md text-sm font-bold transition-all flex items-center gap-1 ${filterMode === 'ISSUES' ? 'bg-red-100 text-red-800' : 'text-gray-500 hover:bg-gray-100'}`}><AlertTriangle size={14}/> 不具合/故障のみ</button>
            </div>
            {/* Search Bar */}
            <div className="relative flex-1 max-w-xs">
                <Search className="absolute left-3 top-2.5 text-gray-400" size={16} />
                <input 
                    type="text" 
                    placeholder="履歴を検索 (ch, 病棟, 名前...)" 
                    value={searchTerm} 
                    onChange={(e) => setSearchTerm(e.target.value)} 
                    className="w-full pl-9 pr-4 py-2 bg-white border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-300 text-sm" 
                />
                 {searchTerm && <button onClick={() => setSearchTerm('')} className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600"><X size={16}/></button>}
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 bg-gray-100">
          {loading ? <div className="text-center p-10 text-gray-500">データを読み込んでいます...</div> : (
            <div className="space-y-6">
              {sortedDateKeys.length === 0 && <div className="text-center p-10 text-gray-400">該当するデータがありません</div>}
              {sortedDateKeys.map((date) => {
                const wardsData = displayStructure[date];
                // 担当者の集計
                const checkers = Array.from(new Set(
                    wardsData.flatMap(w => w.monitors.flatMap(m => m.records.map(r => r.checker)))
                )).filter(Boolean).join(', ');

                return (
                <div key={date} className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
                  <div 
                    onClick={() => toggleDate(date)} 
                    className="bg-gray-50 px-4 py-3 border-b border-gray-200 flex justify-between items-center cursor-pointer hover:bg-gray-100 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2 font-bold text-gray-700 text-lg"><Calendar size={20}/> {date}</div>
                        {checkers && <div className="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded border border-blue-100 flex items-center gap-1"><User size={12}/> {checkers}</div>}
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={(e) => { e.stopPropagation(); onDownloadCSV(groupedHistory[date], date); }} className="text-xs flex items-center gap-1 text-green-600 hover:bg-green-100 bg-white border border-green-200 px-3 py-1.5 rounded transition-colors mr-2"><Download size={14}/> CSV</button>
                        {expandedDates[date] ? <ChevronUp size={20} className="text-gray-400"/> : <ChevronDown size={20} className="text-gray-400"/>}
                    </div>
                  </div>
                  
                  {expandedDates[date] && (
                    <div className="animate-slide-up">
                      {/* 病棟ごとのループ */}
                      {wardsData.map(wardData => {
                        const wardKey = `${date}_${wardData.wardName}`;
                        const isWardExpanded = expandedWards[wardKey] !== false; // デフォルトで開くなら true 扱い、あるいはステート初期化が必要。ここではクリックで開閉できるようにするが、初期は開いておく？「対象のデータを下に表示したり格納したり」なので、初期は閉じておくか開けておくか。とりあえず開けておく実装（undefinedなら開く）にするか、明示的に管理するか。今回は明示的に管理せず、クリックしたらstateにセットされる方式（初期は閉じてる＝undefinedでfalsy）だと全部閉じてしまう。
                        // なので、初期状態は「未定義なら開く」または「expandedWardsに初期値を入れる」
                        // 簡易的に「未定義なら開く(true)」とする
                        const isOpen = expandedWards[wardKey] !== false;

                        return (
                        <div key={wardData.wardName}>
                             <div 
                                onClick={() => toggleWard(date, wardData.wardName)}
                                className="bg-blue-50/50 px-4 py-2 text-sm font-bold text-blue-800 border-b border-blue-100 flex justify-between items-center cursor-pointer hover:bg-blue-100/50"
                             >
                                 <div className="flex items-center gap-2"><MapPin size={16}/> {wardData.wardName}</div>
                                 {isOpen ? <ChevronUp size={16} className="text-blue-400"/> : <ChevronDown size={16} className="text-blue-400"/>}
                             </div>
                             
                             {isOpen && (
                                 <div className="animate-slide-up">
                                     {/* モニタごとのループ */}
                                     {wardData.monitors.map(monitorData => (
                                         <div key={monitorData.monitorName} className="border-b border-gray-100 last:border-b-0">
                                             <div className="bg-gray-50/30 px-4 py-1 text-xs font-bold text-gray-500 border-b border-gray-100 flex items-center gap-1 pl-8">
                                                 <Monitor size={12}/> {monitorData.monitorName}
                                             </div>
                                             <div className="divide-y divide-gray-100">
                                                 {monitorData.records.map((r, i) => {
                                                      const isIssue = r.reception === 'BAD' || r.isBroken === 'YES' || r.channelCheck === 'NG';
                                                      const receptionText = r.receptionReason ? `${r.receptionReason}: ${receptionReasonMap[r.receptionReason] || ''}` : '';
                                                      const extraInfo = [];
                                                      if (r.receptionReason === 'D' && r.receptionNote) extraInfo.push(`その他理由: ${r.receptionNote}`);
                                                      if (r.note) extraInfo.push(`備考: ${r.note}`);
    
                                                      return (
                                                        <div key={i} className={`p-3 text-sm flex flex-col gap-2 hover:bg-gray-50 ${isIssue ? 'bg-red-50/50' : ''}`}>
                                                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                                                            <div className="flex items-center gap-3">
                                                                <span className="text-gray-400 text-xs font-mono">{r.timestamp.split(' ')[1]}</span>
                                                                <span className="font-bold w-16 text-lg">{r.deviceId}</span>
                                                                <span className="text-xs text-gray-500 ml-2">{r.model}</span>
                                                            </div>
                                                            <div className="flex items-center gap-4">
                                                                {r.inUse === 'YES' ? <span className="text-blue-600 text-xs bg-blue-50 px-2 py-0.5 rounded border border-blue-100">使用中</span> : <span className="text-gray-400 text-xs">未使用</span>}
                                                                {r.reception === 'BAD' && <span className="flex items-center gap-1 text-red-600 font-bold text-xs bg-red-100 px-2 py-0.5 rounded"><AlertTriangle size={12}/> 受信不良 ({receptionText})</span>}
                                                                {r.isBroken === 'YES' && <span className="flex items-center gap-1 text-red-600 font-bold text-xs bg-red-100 px-2 py-0.5 rounded"><AlertOctagon size={12}/> 破損あり</span>}
                                                                {r.channelCheck === 'NG' && <span className="flex items-center gap-1 text-red-600 font-bold text-xs bg-red-100 px-2 py-0.5 rounded"><AlertTriangle size={12}/> ch不一致</span>}
                                                                {!isIssue && r.inUse === 'YES' && <span className="text-green-600 text-xs flex items-center gap-1"><CheckCircle size={12}/> 良好</span>}
                                                            </div>
                                                          </div>
                                                          {/* 詳細情報表示エリア */}
                                                          {extraInfo.length > 0 && (
                                                            <div className="ml-10 sm:ml-24 text-xs text-gray-600 flex flex-col gap-1 bg-white/50 p-2 rounded border border-gray-100">
                                                                {extraInfo.map((info, idx) => (
                                                                    <div key={idx} className="flex items-start gap-1"><MessageSquare size={12} className="mt-0.5 text-gray-400 shrink-0"/> {info}</div>
                                                                ))}
                                                            </div>
                                                          )}
                                                        </div>
                                                      );
                                                 })}
                                             </div>
                                         </div>
                                     ))}
                                 </div>
                             )}
                        </div>
                      );
                      })}
                    </div>
                  )}
                </div>
              );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;