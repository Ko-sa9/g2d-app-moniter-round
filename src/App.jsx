import React, { useState, useMemo, useEffect, useRef } from 'react';
import { 
  Download, CheckCircle, AlertTriangle, Save, Search, X, ChevronRight, 
  Activity, Filter, MapPin, Monitor, Settings, User, Plus, Trash2, Edit2, 
  History, LogOut, FileText, ChevronDown, ChevronUp, ArrowRight, ArrowLeft,
  Server, Grid, Layers, Menu, BarChart2, Calendar, AlertOctagon, HelpCircle,
  Cloud, Clock, FastForward, MessageSquare, ArrowUp, ArrowDown, Info, List
} from 'lucide-react';

import { initializeApp } from "firebase/app";
import { 
  getFirestore, collection, doc, setDoc, getDocs, deleteDoc, 
  query, where, onSnapshot, writeBatch, orderBy, limit
} from "firebase/firestore";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

// ==========================================
// ★★★ ここにFirebaseの設定を貼り付けてください ★★★
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};
// ==========================================

// Firebase Init
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = 'checklist-app-v1';

// Helper: 日付フォーマット統一 (YYYY-MM-DD)
const getTodayString = (dateObj = new Date()) => {
  const y = dateObj.getFullYear();
  const m = ('0' + (dateObj.getMonth() + 1)).slice(-2);
  const d = ('0' + dateObj.getDate()).slice(-2);
  return `${y}-${m}-${d}`;
};

// Helper: CSVセルエスケープ処理（カンマ・改行・ダブルクォーテーション対策）
const escapeCSVCell = (val) => {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

// Helper: 待機場所（ME室など、日常のラウンド点検対象外となる場所）の判定
const isStandbyWard = (ward) => {
  if (!ward) return false;
  const trimmed = ward.trim();
  const upper = trimmed.toUpperCase();
  return upper === 'ME室' || upper.startsWith('ME室') || trimmed.includes('待機');
};

// Helper: 指定した点検日(recordDate: YYYY-MM-DD)時点で機器が削除済み扱いとなるか判定
// ※後から削除された機器でも、削除日(deletedAt)より前の過去日の日報・履歴では通常稼働機器として扱う
const isDeviceDeletedOnDate = (deviceMaster, recordDate) => {
  if (!deviceMaster) return true;
  if (!deviceMaster.isDeleted) return false;
  if (deviceMaster.deletedAt && recordDate && recordDate < deviceMaster.deletedAt) {
    return false;
  }
  return true;
};

// Helper: 指定した対象月(monthStr: YYYY-MM)において機器が削除済み扱いとなるか判定
// ※後から削除された機器でも、削除月より前の過去月の月報では通常稼働機器として扱う
const isDeviceDeletedInMonth = (deviceMaster, monthStr) => {
  if (!deviceMaster) return true;
  if (!deviceMaster.isDeleted) return false;
  if (deviceMaster.deletedAt && monthStr && monthStr < deviceMaster.deletedAt.slice(0, 7)) {
    return false;
  }
  return true;
};

// Helper: Firestore writeBatchの上限(500件)を考慮して分割コミットするヘルパー
const commitBatchUpdates = async (firestoreDb, updateList) => {
  const CHUNK_SIZE = 450;
  for (let i = 0; i < updateList.length; i += CHUNK_SIZE) {
    const chunk = updateList.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(firestoreDb);
    chunk.forEach(op => {
      if (op.type === 'set') {
        batch.set(op.ref, op.data, op.options || {});
      } else if (op.type === 'update') {
        batch.update(op.ref, op.data);
      } else if (op.type === 'delete') {
        batch.delete(op.ref);
      }
    });
    await batch.commit();
  }
};

function App() {
  // ユーザー認証・担当者情報
  const [user, setUser] = useState(null);
  const [currentStaff, setCurrentStaff] = useState('');
  
  // マスタデータ群
  const [devices, setDevices] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [transmitterModels, setTransmitterModels] = useState([]);
  const [wardList, setWardList] = useState([]); // 病棟マスタ（表示順序保持用）
  const [monitorList, setMonitorList] = useState([]); // モニタマスタ（単体登録モニタ保持用）
  const [todayRecordsList, setTodayRecordsList] = useState([]); // 本日の点検記録リスト（同日複数病棟での点検に対応）

  // UI状態管理
  const [selectedWard, setSelectedWard] = useState(null);
  // selectedDevice: 現在展開中（編集モード）のデバイスIDを保持
  const [selectedDevice, setSelectedDevice] = useState(null); 
  // historyTargetDevice: 個別履歴を表示する対象のデバイス
  const [historyTargetDevice, setHistoryTargetDevice] = useState(null);

  // モーダル・メニュー表示フラグ
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showConfirmSave, setShowConfirmSave] = useState(false);
  const [showWardMenu, setShowWardMenu] = useState(false);
  
  // 時計用のstate
  const [currentTime, setCurrentTime] = useState(new Date());

  // ★スクロール制御用のStateとRef
  const mainScrollRef = useRef(null);
  const [showFooter, setShowFooter] = useState(true); // 初期値はTopにいるので表示

  // 本日の日付（日付またぎやスリープ復帰時に自動更新）
  const [today, setToday] = useState(() => getTodayString());

  // 時計の更新（1秒ごと）＋日付またぎ・スリープ復帰時の日付自動更新
  useEffect(() => {
    const checkTimeAndDate = () => {
      const now = new Date();
      setCurrentTime(now);
      const currentDayStr = getTodayString(now);
      setToday(prev => (prev !== currentDayStr ? currentDayStr : prev));
    };
    const timer = setInterval(checkTimeAndDate, 1000);
    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        checkTimeAndDate();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    window.addEventListener('focus', handleVisibilityOrFocus);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      window.removeEventListener('focus', handleVisibilityOrFocus);
    };
  }, []);

  // 担当者名のローカルストレージへの永続化と日付変更時のリセット処理
  useEffect(() => {
      const savedData = localStorage.getItem('g2d_staff_curr');
      if (savedData) {
          try {
              const parsed = JSON.parse(savedData);
              if (parsed.date === today) {
                  setCurrentStaff(parsed.name);
              } else {
                  // 日付が変わっている場合はリセット
                  localStorage.removeItem('g2d_staff_curr');
                  setCurrentStaff('');
              }
          } catch (e) {
              console.error("Storage parse error", e);
          }
      }
  }, [today]);

  useEffect(() => {
      if (currentStaff) {
          localStorage.setItem('g2d_staff_curr', JSON.stringify({ name: currentStaff, date: today }));
      }
  }, [currentStaff, today]);

  // 匿名認証の初期化
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

  // Data Sync: Firestoreからのリアルタイムデータ同期
  useEffect(() => {
    if (!user) return;
    
    // 1. Devices (機器マスタ)
    const unsubDevices = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'devices'), (snapshot) => {
      const list = snapshot.docs.map(d => d.data());
      // sortOrder優先でソート
      list.sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.id.localeCompare(b.id));
      setDevices(list);
    }, (error) => console.error("Device sync error", error));

    // 2. Staff (担当者マスタ)
    const unsubStaff = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'staff'), (snapshot) => {
      const list = snapshot.docs.map(d => d.data());
      list.sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999));
      setStaffList(list);
    }, (error) => console.error("Staff sync error", error));

    // 3. Models (型番マスタ)
    // 修正: sortOrder順にソートするよう修正
    const unsubModels = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'transmitter_models'), (snapshot) => {
      const list = snapshot.docs.map(d => ({ ...d.data(), id: d.id }));
      list.sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999));
      setTransmitterModels(list);
    }, (error) => console.error("Models sync error", error));

    // 4. Wards (病棟マスタ・順序)
    const unsubWards = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'wards'), (snapshot) => {
      const list = snapshot.docs.map(d => d.data());
      // sortOrder順にソート
      list.sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999));
      setWardList(list);
    }, (error) => console.error("Wards sync error", error));

    // 5. Monitors (モニタマスタ・単体登録用)
    const unsubMonitors = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'monitors'), (snapshot) => {
      const list = snapshot.docs.map(d => ({ docId: d.id, ...d.data() }));
      setMonitorList(list);
    }, (error) => console.error("Monitors sync error", error));

    // 6. Checks (本日の点検記録: 同日中に別病棟へ移動して2回点検された場合もすべて取得・保持)
    const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'checks'), where('date', '==', today));
    const unsubChecks = onSnapshot(q, (snapshot) => {
      const list = snapshot.docs.map(d => ({ ...d.data(), _docId: d.id }));
      setTodayRecordsList(list);
    }, (error) => console.error("Checks sync error", error));

    return () => { unsubDevices(); unsubStaff(); unsubModels(); unsubWards(); unsubMonitors(); unsubChecks(); };
  }, [user, today]);

  // ★スクロールイベントハンドラ: 上端・下端の検知
  const handleScroll = () => {
    const target = mainScrollRef.current;
    if (!target) return;

    const { scrollTop, scrollHeight, clientHeight } = target;
    
    // 判定基準: 上から20px以内、または 下から20px以内
    // clientHeight(表示領域)がscrollHeight(全体)より大きい場合はスクロール不要なので常に表示
    if (scrollHeight <= clientHeight) {
        setShowFooter(true);
        return;
    }

    const isTop = scrollTop < 20;
    const isBottom = Math.abs(scrollHeight - clientHeight - scrollTop) < 20;

    if (isTop || isBottom) {
      setShowFooter(true);
    } else {
      setShowFooter(false);
    }
  };
  
  // --- Helpers & Computed Values ---
  
  // 有効な機器（論理削除されていない機器）のみを抽出
  const activeDevices = useMemo(() => devices.filter(d => !d.isDeleted), [devices]);

  // デバイスIDごとの本日の全点検記録マップ（同日中に複数病棟で実施された場合は複数件保持）
  const recordsByDevice = useMemo(() => {
    const map = {};
    todayRecordsList.forEach(r => {
      if (!map[r.deviceId]) map[r.deviceId] = [];
      map[r.deviceId].push(r);
    });
    return map;
  }, [todayRecordsList]);

  // 指定デバイスが本日（いずれかの病棟で）1回以上点検済みかどうか
  const hasRecordToday = (deviceId) => Boolean(recordsByDevice[deviceId] && recordsByDevice[deviceId].length > 0);

  // 指定デバイスの「現在の所属（病棟・モニタ）」に対応する本日の点検記録を取得
  const getRecordForDeviceLocation = (device) => {
    if (!device) return null;
    const devRecs = recordsByDevice[device.id] || [];
    const exact = devRecs.find(
      r => r.ward === device.ward && r.monitorGroup === device.monitorGroup
    );
    if (exact) return exact;
    const legacy = devRecs.find(r => !r.ward && !r.monitorGroup);
    return legacy || null;
  };

  // 指定デバイスが本日「別の病棟・モニタ（移動前など）」で点検された記録の一覧を取得
  const getOtherLocationRecordsToday = (device) => {
    if (!device) return [];
    const devRecs = recordsByDevice[device.id] || [];
    return devRecs.filter(
      r => (r.ward || '') !== (device.ward || '') || (r.monitorGroup || '') !== (device.monitorGroup || '')
    );
  };

  // 日常のラウンド点検対象となる機器
  // ※ME室などの待機場所にある機器は原則除外するが、「当日すでに点検済みの機器がME室へ返却された場合」は当日点検分としてカウントに残す
  const roundTargetDevices = useMemo(
    () => activeDevices.filter(d => !isStandbyWard(d.ward) || Boolean(recordsByDevice[d.id] && recordsByDevice[d.id].length > 0)),
    [activeDevices, recordsByDevice]
  );

  // 貸出機として登録されている（またはME室に所属・待機履歴がある）モニタ名のセット
  const loanerMonitorNames = useMemo(() => {
    const names = new Set();
    monitorList.forEach(m => {
      if (m.name && (m.isLoaner || isStandbyWard(m.ward))) {
        names.add(m.name);
      }
    });
    devices.forEach(d => {
      if (d.monitorGroup && isStandbyWard(d.ward)) {
        names.add(d.monitorGroup);
      }
    });
    return names;
  }, [monitorList, devices]);

  // 有効なモニタ一覧（明示的に削除されていないモニタマスタ＋機器マスタ由来のモニタ）
  // ※過去にchが全削除されたモニタも、モニタ自体が削除されていなければ0台モニタとして保持・復元する
  const effectiveMonitors = useMemo(() => {
    const deletedKeys = new Set(
      monitorList.filter(m => m.isDeleted).map(m => `${m.ward}__${m.name}`)
    );
    const map = new Map();
    monitorList.forEach(m => {
      if (!m.isDeleted && m.ward && m.name) {
        map.set(`${m.ward}__${m.name}`, {
          ward: m.ward,
          name: m.name,
          isLoaner: Boolean(m.isLoaner || loanerMonitorNames.has(m.name))
        });
      }
    });
    devices.forEach(d => {
      if (!d.ward || !d.monitorGroup) return;
      const key = `${d.ward}__${d.monitorGroup}`;
      if (!d.isDeleted || !deletedKeys.has(key)) {
        if (!map.has(key)) {
          map.set(key, {
            ward: d.ward,
            name: d.monitorGroup,
            isLoaner: Boolean(loanerMonitorNames.has(d.monitorGroup))
          });
        }
      }
    });
    return Array.from(map.values());
  }, [monitorList, devices, loanerMonitorNames]);

  // 病棟リストの生成（マスタの表示順序を反映、モニタ単体登録のある病棟も含む）
  const wards = useMemo(() => {
    const list = Array.from(new Set([
      ...activeDevices.map(d => d.ward),
      ...effectiveMonitors.map(m => m.ward)
    ])).filter(Boolean);
    
    // DBのwardListがある場合はそのsortOrderを優先（待機場所「ME室」はデフォルト末尾）
    return list.sort((a, b) => {
      const wa = wardList.find(w => w.name === a);
      const wb = wardList.find(w => w.name === b);
      
      const orderA = wa ? (wa.sortOrder ?? 9999) : (isStandbyWard(a) ? 99999 : 9999);
      const orderB = wb ? (wb.sortOrder ?? 9999) : (isStandbyWard(b) ? 99999 : 9999);
      
      if (orderA !== orderB) return orderA - orderB;
      return a.localeCompare(b);
    });
  }, [activeDevices, effectiveMonitors, wardList]);

  // 選択中の病棟でフィルタリングされたデバイスリスト
  const filteredDevices = useMemo(() => {
    let list = activeDevices;
    if (selectedWard) list = list.filter(d => d.ward === selectedWard);
    return list;
  }, [selectedWard, activeDevices]); 

  // モニタグループごとにデバイスをまとめる（単体登録・0台モニタも含む）
  const groupedDevices = useMemo(() => {
    if (!selectedWard) return null; 
    const groups = {};
    effectiveMonitors.filter(m => m.ward === selectedWard).forEach(m => {
      if (m.name && !groups[m.name]) groups[m.name] = [];
    });
    filteredDevices.forEach(device => {
      if (!groups[device.monitorGroup]) groups[device.monitorGroup] = [];
      groups[device.monitorGroup].push(device);
    });
    return groups;
  }, [selectedWard, filteredDevices, effectiveMonitors]);

  // 全体の進捗率計算（待機中機器は原則除外、ただし本日点検済みのままME室へ返却された機器はカウントに残す）
  const totalProgress = useMemo(() => {
    if (roundTargetDevices.length === 0) return 0;
    const checkedCount = roundTargetDevices.filter(d => Boolean(recordsByDevice[d.id] && recordsByDevice[d.id].length > 0)).length;
    return Math.round((checkedCount / roundTargetDevices.length) * 100);
  }, [roundTargetDevices, recordsByDevice]);

  // CSVダウンロード処理 (日報)
  const handleDownloadCSV = (targetRecords, fileNameDate) => {
    const list = Array.isArray(targetRecords) ? targetRecords : Object.values(targetRecords);
    const header = ['点検日', '時間', '病棟', '点検者', 'モニタ', 'ch', '送信機型番', '①使用中', '②受信状態', '不良理由', '備考', '③破損', '④ch確認'];
    
    const getWardOrder = (wardName) => {
      const w = wardList.find(item => item.name === wardName);
      return w ? (w.sortOrder ?? 9999) : (isStandbyWard(wardName) ? 99999 : 9999);
    };
    const getDeviceOrder = (deviceId) => {
      const d = devices.find(dev => dev.id === deviceId);
      return d ? (d.sortOrder ?? 9999) : 9999;
    };
    const sortDailyRecords = (recs) => {
      return [...recs].sort((a, b) => {
        const deviceA = devices.find(d => d.id === a.deviceId);
        const deviceB = devices.find(d => d.id === b.deviceId);
        const wardA = a.ward || deviceA?.ward || '';
        const wardB = b.ward || deviceB?.ward || '';
        const monA = a.monitorGroup || deviceA?.monitorGroup || '';
        const monB = b.monitorGroup || deviceB?.monitorGroup || '';

        const wa = getWardOrder(wardA);
        const wb = getWardOrder(wardB);
        if (wa !== wb) return wa - wb;
        if (wardA !== wardB) return wardA.localeCompare(wardB);
        if (monA !== monB) return monA.localeCompare(monB);

        const da = getDeviceOrder(a.deviceId);
        const db = getDeviceOrder(b.deviceId);
        if (da !== db) return da - db;
        return a.deviceId.localeCompare(b.deviceId);
      });
    };

    const formatRow = (r) => {
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
        badReason, r.note || '',
        r.isBroken === 'YES' ? '破損あり' : (r.isBroken === 'NO' ? 'なし' : '-'),
        r.channelCheck === 'OK' ? 'OK' : (r.channelCheck === 'NG' ? 'NG' : '-'),
      ].map(escapeCSVCell).join(',');
    };

    const activeRecords = [];
    const deletedRecords = [];
    list.forEach(r => {
      const deviceMaster = devices.find(d => d.id === r.deviceId);
      // 点検日(r.date)時点で削除済みだったかどうかで判定（後から削除されたchが過去の日報で削除済み扱いになるのを防ぐ）
      if (isDeviceDeletedOnDate(deviceMaster, r.date || fileNameDate)) {
        deletedRecords.push(r);
      } else {
        activeRecords.push(r);
      }
    });

    const rows = sortDailyRecords(activeRecords).map(formatRow);
    if (deletedRecords.length > 0) {
      rows.push(['【削除済み機器】', ...Array(header.length - 1).fill('')].map(escapeCSVCell).join(','));
      rows.push(...sortDailyRecords(deletedRecords).map(formatRow));
    }

    // Windows対策: BOM (0xEF, 0xBB, 0xBF) を付与
    const csvContent = [header.map(escapeCSVCell).join(','), ...rows].join('\n');
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const blob = new Blob([bom, csvContent], { type: "text/csv;charset=utf-8" });
    
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `送信機点検結果_${fileNameDate}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const executeSave = () => {
    setShowConfirmSave(false);
  };

  // デバイスの展開切り替え処理
  const toggleDevice = (device) => {
    setShowWardMenu(false);
    if (selectedDevice && selectedDevice.id === device.id) {
      setSelectedDevice(null); // 同じものをタップしたら閉じる
    } else {
      setSelectedDevice(device);
    }
  };

  // 個別履歴表示
  const handleShowDeviceHistory = (device) => {
      setHistoryTargetDevice(device);
  };

  // 点検記録の保存処理 (インラインフォームから呼ばれる)
  const handleSaveRecord = async (record, action = 'CLOSE') => {
    // inUseがnull（未入力）の場合は保存をスキップする
    if (record.inUse !== null) {
        const deviceMaster = devices.find(d => d.id === record.deviceId);
        if(deviceMaster) {
            const devRecs = recordsByDevice[record.deviceId] || [];
            // 同じ日・同じ病棟・同じモニタでの記録が既にある場合はそのドキュメントを上書き更新
            const existingSameLoc = devRecs.find(
              r => r.ward === deviceMaster.ward && r.monitorGroup === deviceMaster.monitorGroup
            ) || devRecs.find(r => !r.ward && !r.monitorGroup);

            let docId;
            if (existingSameLoc && existingSameLoc._docId) {
              docId = existingSameLoc._docId;
            } else if (devRecs.length === 0) {
              // 当日1件目の点検は従来通りのID形式
              docId = `${record.date}_${record.deviceId}`;
            } else {
              // 当日すでに別病棟・別モニタで点検済みで、移動先で再実施した場合は2件目として別IDで保存（両方残す）
              docId = `${record.date}_${record.deviceId}_${encodeURIComponent(`${deviceMaster.ward}__${deviceMaster.monitorGroup}`)}`;
            }

            const { _docId, ...cleanRecord } = record;
            const recordWithSnapshot = { 
                ...cleanRecord, 
                model: deviceMaster.model, 
                monitorGroup: deviceMaster.monitorGroup, 
                ward: deviceMaster.ward 
            };
            await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'checks', docId), recordWithSnapshot);
        }
    }

    // 次へ/前へボタンのアクション処理
    if (action === 'NEXT' || action === 'PREV') {
        const currentIndex = filteredDevices.findIndex(d => d.id === record.deviceId);
        if (action === 'NEXT') {
            if (currentIndex >= 0 && currentIndex < filteredDevices.length - 1) {
                setSelectedDevice(filteredDevices[currentIndex + 1]);
            } else {
                setSelectedDevice(null);
            }
        } else if (action === 'PREV') {
            if (currentIndex > 0) {
                setSelectedDevice(filteredDevices[currentIndex - 1]);
            }
        }
    } else if (action === 'STAY') {
        // STAYの場合は選択状態を解除せず、そのままにする
    } else {
        setSelectedDevice(null);
    }
  };

  // 点検記録の削除処理
  const handleDeleteRecord = async (record) => {
    if(confirm('この点検記録を取り消しますか？\nデータは削除され「未実施」に戻ります。')) {
      const docId = record._docId || `${record.date}_${record.deviceId}`;
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'checks', docId));
    }
  };


  if (!user) return <div className="flex h-screen items-center justify-center">Loading...</div>;

  return (
    <div className="flex flex-col h-screen bg-gray-50 text-gray-800 font-sans overflow-hidden">
      {/* Header Area */}
      <header className="bg-blue-600 text-white p-3 shadow-md sticky top-0 z-10">
        <div className="max-w-3xl mx-auto w-full flex flex-col gap-2">
          <div className="flex justify-between items-center">
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
            <div className="bg-blue-800/50 p-2 rounded-lg text-xs font-mono text-blue-100 flex flex-col justify-center items-end leading-tight min-w-[120px]">
              <div>{currentTime.toLocaleDateString('ja-JP')}</div>
              <div className="text-sm font-bold">{currentTime.toLocaleTimeString('ja-JP')}</div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main 
        ref={mainScrollRef} 
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 pb-24" // Footer避けの余白確保
      >
        <div className="max-w-3xl mx-auto w-full space-y-6">
          {!selectedWard ? (
            // 病棟選択画面
            <div className="space-y-4 animate-fade-in">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2"><MapPin size={18} className="text-blue-600" /><h2 className="text-md font-bold text-gray-700">病棟を選択してください</h2></div>
              </div>
              
              <div className="bg-white p-3 rounded-lg shadow-sm border border-gray-100 mb-4">
                <div className="flex justify-between items-end mb-1">
                  <span className="text-xs font-bold text-gray-500">本日の点検進捗 (全体)</span>
                  <span className="font-mono text-lg font-bold text-blue-600">{totalProgress}%</span>
                </div>
                <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 transition-all duration-500 ease-out" style={{ width: `${totalProgress}%` }} />
                </div>
                <div className="text-right text-xs text-gray-400 mt-1">
                  {roundTargetDevices.filter(d => hasRecordToday(d.id)).length} / {roundTargetDevices.length} 台
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {wards.filter(w => !isStandbyWard(w)).map(ward => {
                    // ★病棟ごとの進捗計算（現在の病棟で点検済みの台数）
                    const wardDevices = activeDevices.filter(d => d.ward === ward);
                    const wardTotal = wardDevices.length;
                    const wardChecked = wardDevices.filter(d => Boolean(getRecordForDeviceLocation(d))).length;
                    const wardProgress = wardTotal > 0 ? Math.round((wardChecked / wardTotal) * 100) : 0;
                    const hasLoanerInWard = effectiveMonitors.some(m => m.ward === ward && m.isLoaner);
                    
                    return (
                      <button key={ward} onClick={() => setSelectedWard(ward)} className="p-4 bg-white rounded-lg shadow-sm border border-gray-200 hover:border-blue-300 hover:shadow-md transition-all active:scale-95 text-left group">
                        <div className="flex items-center justify-between gap-1 mb-2">
                          <span className="block text-lg font-bold text-gray-800 group-hover:text-blue-600 truncate">{ward}</span>
                          {hasLoanerInWard && (
                            <span className="text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200 px-1.5 py-0.5 rounded flex-shrink-0">
                              貸出機あり
                            </span>
                          )}
                        </div>
                        
                        {/* 進捗バー表示 */}
                        <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden mb-1">
                            <div className="h-full bg-blue-500 transition-all duration-500" style={{ width: `${wardProgress}%` }}></div>
                        </div>
                        <div className="flex justify-between items-end">
                            <span className="text-xs text-gray-400">{wardChecked} / {wardTotal} 台</span>
                            <span className="text-sm font-bold text-blue-600">{wardProgress}%</span>
                        </div>
                      </button>
                    );
                })}
              </div>

              {/* 待機場所（ME室など・点検対象外）の表示枠 */}
              {wards.some(w => isStandbyWard(w)) && (
                <div className="pt-2">
                  <div className="text-xs font-bold text-gray-500 mb-2 flex items-center gap-1.5">
                    <Server size={14} className="text-gray-400" />
                    <span>貸出機待機場所（本日の点検対象外）</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {wards.filter(w => isStandbyWard(w)).map(ward => {
                      const standbyMonitors = effectiveMonitors.filter(m => m.ward === ward);
                      const standbyDevices = activeDevices.filter(d => d.ward === ward);
                      const checkedBeforeReturnCount = standbyDevices.filter(d => hasRecordToday(d.id)).length;
                      return (
                        <button
                          key={ward}
                          onClick={() => setSelectedWard(ward)}
                          className="p-3.5 bg-gray-100/80 rounded-lg border border-dashed border-gray-300 hover:border-blue-300 hover:bg-white transition-all active:scale-95 text-left flex items-center justify-between"
                        >
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-bold text-gray-700">{ward}</span>
                              <span className="text-[11px] bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full font-bold">
                                待機中・点検対象外
                              </span>
                              {checkedBeforeReturnCount > 0 && (
                                <span className="text-[11px] bg-green-100 text-green-700 border border-green-200 px-2 py-0.5 rounded-full font-bold">
                                  本日点検後に返却: {checkedBeforeReturnCount}台（全体進捗に算入済）
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-gray-500 mt-1">
                              待機モニタ: <span className="font-bold text-gray-700">{standbyMonitors.length}</span>台 / 送信機: <span className="font-bold text-gray-700">{standbyDevices.length}</span>台
                            </div>
                          </div>
                          <ChevronRight size={18} className="text-gray-400" />
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : (
            // 機器リスト表示画面（病棟選択後）
            <div className="space-y-4 animate-slide-up">
              {/* 上部ステータス表示（現在病棟の表示と一覧へ戻るリンク） */}
              <div className="flex justify-between items-center">
                <button
                  onClick={() => {
                    setSelectedWard(null);
                    setSelectedDevice(null);
                    setShowWardMenu(false);
                  }}
                  className="flex items-center gap-1 text-xs font-bold text-gray-500 hover:text-blue-600 px-2 py-1 rounded transition-colors"
                >
                  <ArrowLeft size={14} />
                  <span>病棟一覧</span>
                </button>
                <div className="flex items-center gap-1.5 text-sm font-bold bg-white px-3.5 py-1.5 rounded-full shadow-sm border border-gray-200 text-gray-700">
                  <MapPin size={14} className={isStandbyWard(selectedWard) ? 'text-gray-500' : 'text-blue-600'} />
                  <span>{selectedWard}</span>
                  {isStandbyWard(selectedWard) ? (
                    <span className="text-xs font-bold text-gray-600 bg-gray-100 px-2 py-0.5 rounded ml-1">
                      待機中（点検対象外）
                    </span>
                  ) : (
                    <span className="text-xs font-mono text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded ml-1">
                      {filteredDevices.filter(d => Boolean(getRecordForDeviceLocation(d))).length}/{filteredDevices.length}
                    </span>
                  )}
                </div>
              </div>

              {isStandbyWard(selectedWard) && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 flex items-center justify-between gap-2">
                  <span>
                    <strong>{selectedWard}</strong>で待機中の機器は本日の点検進捗（％）の対象外です（ただし本日病棟で点検したあとに返却された機器は本日分の点検カウントに残ります）。病棟へ貸し出す際は「設定（⚙️）＞ 機器マスタ」から移動してください。
                  </span>
                  <button
                    onClick={() => setShowSettings(true)}
                    className="px-2.5 py-1.5 bg-white border border-amber-300 rounded font-bold text-amber-800 hover:bg-amber-100 flex-shrink-0 transition-colors"
                  >
                    機器マスタを開く
                  </button>
                </div>
              )}
              
              <div className="space-y-6 pb-24">
                {groupedDevices ? (
                  // モニタごとにグルーピングして表示
                  Object.entries(groupedDevices).map(([groupName, groupDevices]) => {
                    const isLoanerMonitor = loanerMonitorNames.has(groupName);
                    return (
                      <div key={groupName} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                        <div className="bg-gray-100 px-4 py-2 border-b border-gray-200 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Monitor size={16} className="text-gray-500" />
                            <span className="font-bold text-sm text-gray-700 font-mono">{groupName}</span>
                            {isLoanerMonitor && !isStandbyWard(selectedWard) && (
                              <span className="text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-300 px-2 py-0.5 rounded-full">
                                貸出機
                              </span>
                            )}
                            {isStandbyWard(selectedWard) && (
                              <span className="text-[11px] font-bold bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">
                                待機中
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="divide-y divide-gray-100">
                          {groupDevices.length > 0 ? groupDevices.map(device => (
                            <DeviceRow 
                              key={device.id} 
                              device={device} 
                              record={getRecordForDeviceLocation(device)}
                              otherTodayRecords={getOtherLocationRecordsToday(device)}
                              isExpanded={selectedDevice?.id === device.id}
                              onToggle={() => toggleDevice(device)}
                              onSave={handleSaveRecord}
                              onDelete={handleDeleteRecord}
                              onShowHistory={() => handleShowDeviceHistory(device)} 
                              checker={currentStaff}
                              isFirst={filteredDevices.length > 0 && filteredDevices[0].id === device.id}
                              isLast={filteredDevices.length > 0 && filteredDevices[filteredDevices.length - 1].id === device.id}
                              date={today}
                            />
                          )) : (
                            <div className="p-4 text-center text-xs text-gray-400">送信機が登録されていません</div>
                          )}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  // グルーピングなし
                  <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden divide-y divide-gray-100">
                    {filteredDevices.map(device => (
                        <DeviceRow 
                            key={device.id} 
                            device={device} 
                            record={getRecordForDeviceLocation(device)}
                            otherTodayRecords={getOtherLocationRecordsToday(device)}
                            isExpanded={selectedDevice?.id === device.id}
                            onToggle={() => toggleDevice(device)}
                            onSave={handleSaveRecord}
                            onDelete={handleDeleteRecord}
                            onShowHistory={() => handleShowDeviceHistory(device)} 
                            checker={currentStaff}
                            isFirst={filteredDevices.length > 0 && filteredDevices[0].id === device.id}
                            isLast={filteredDevices.length > 0 && filteredDevices[filteredDevices.length - 1].id === device.id}
                            date={today}
                        />
                    ))}
                  </div>
                )}
                {filteredDevices.length === 0 && (!groupedDevices || Object.keys(groupedDevices).length === 0) && (
                  <div className="text-center py-10 text-gray-400 text-sm">該当する機器が見つかりません</div>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
      
      {/* 右下フローティング病棟切り替えボタン（常時表示） */}
      <div
        className={`fixed bottom-5 right-4 z-30 transition-all duration-300 ease-in-out ${
          selectedWard
            ? 'translate-y-0 opacity-100'
            : 'translate-y-24 opacity-0 pointer-events-none'
        }`}
      >
        {selectedWard && (
          <div className="relative">
            {showWardMenu && (
              <>
                {/* メニュー外タップで閉じる透明オーバーレイ */}
                <div className="fixed inset-0 z-20" onClick={() => setShowWardMenu(false)} />

                {/* 上方向に開く病棟選択ポップアップメニュー */}
                <div className="absolute right-0 bottom-full mb-3 w-64 bg-white rounded-2xl shadow-2xl border border-gray-200 z-30 overflow-hidden animate-fade-in">
                  <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 text-[11px] font-bold text-gray-500 flex items-center justify-between">
                    <span>病棟を切り替え</span>
                    <span className="font-mono text-blue-600">全体 {totalProgress}%</span>
                  </div>

                  <div className="max-h-64 overflow-y-auto divide-y divide-gray-100">
                    {wards.map(ward => {
                      const wardDevices = activeDevices.filter(d => d.ward === ward);
                      const wardTotal = wardDevices.length;
                      const wardChecked = wardDevices.filter(d => Boolean(getRecordForDeviceLocation(d))).length;
                      const wardProgress = wardTotal > 0 ? Math.round((wardChecked / wardTotal) * 100) : 0;
                      const isCurrent = ward === selectedWard;
                      const isStandby = isStandbyWard(ward);
                      const isComplete = !isStandby && wardTotal > 0 && wardChecked === wardTotal;
                      const standbyMonitorCount = isStandby ? effectiveMonitors.filter(m => m.ward === ward).length : 0;

                      return (
                        <button
                          key={ward}
                          onClick={() => {
                            setSelectedWard(ward);
                            setSelectedDevice(null);
                            setShowWardMenu(false);
                            if (mainScrollRef.current) {
                              mainScrollRef.current.scrollTo({ top: 0, behavior: 'smooth' });
                            }
                          }}
                          className={`w-full px-4 py-2.5 text-left flex items-center justify-between transition-colors ${
                            isCurrent ? 'bg-blue-50/90 text-blue-700 font-bold' : 'hover:bg-gray-50 text-gray-700'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                              isCurrent ? 'bg-blue-600' : isStandby ? 'bg-gray-400' : isComplete ? 'bg-green-500' : 'bg-gray-300'
                            }`} />
                            <span className="text-sm truncate">{ward}</span>
                          </div>
                          {isStandby ? (
                            <span className="text-[11px] font-bold bg-gray-100 text-gray-600 px-2 py-0.5 rounded flex-shrink-0 ml-2">
                              待機 ({standbyMonitorCount}台)
                            </span>
                          ) : (
                            <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                              <span className="text-xs text-gray-400 font-mono">{wardChecked}/{wardTotal}</span>
                              <span className={`text-xs font-bold font-mono px-1.5 py-0.5 rounded ${
                                isComplete ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
                              }`}>
                                {wardProgress}%
                              </span>
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* 親指に一番近い下部に「病棟一覧へ戻る」を配置 */}
                  <button
                    onClick={() => {
                      setSelectedWard(null);
                      setSelectedDevice(null);
                      setShowWardMenu(false);
                    }}
                    className="w-full px-4 py-3 text-left text-xs font-bold text-gray-700 bg-gray-50 hover:bg-blue-50 hover:text-blue-700 flex items-center justify-center gap-2 border-t border-gray-200 transition-colors"
                  >
                    <Grid size={15} className="text-blue-600" />
                    <span>病棟選択画面（一覧）へ戻る</span>
                  </button>
                </div>
              </>
            )}

            {/* 右下フローティングボタン本体 */}
            <button
              onClick={() => setShowWardMenu(prev => !prev)}
              className="flex items-center gap-2.5 bg-blue-600 hover:bg-blue-700 active:scale-95 text-white pl-4 pr-3.5 py-3 rounded-full shadow-xl border border-blue-500 transition-all"
              title="タップして病棟を切り替え"
            >
              <MapPin size={18} className="text-blue-100 flex-shrink-0" />
              <span className="font-bold text-sm tracking-wide">{selectedWard}</span>
              {isStandbyWard(selectedWard) ? (
                <span className="text-xs font-bold bg-white/20 px-2 py-0.5 rounded-full">
                  待機
                </span>
              ) : (
                <span className="text-xs font-mono font-bold bg-white/20 px-2 py-0.5 rounded-full">
                  {filteredDevices.filter(d => Boolean(getRecordForDeviceLocation(d))).length}/{filteredDevices.length}
                </span>
              )}
              <ChevronUp
                size={18}
                className={`text-blue-100 transition-transform duration-200 ${showWardMenu ? 'rotate-180' : ''}`}
              />
            </button>
          </div>
        )}
      </div>

      {/* 確認モーダル */}
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

      {/* 設定モーダル */}
      {showSettings && <SettingsModal devices={devices} staffList={staffList} transmitterModels={transmitterModels} wardList={wardList} monitorList={effectiveMonitors} onClose={() => setShowSettings(false)} />}
      
      {/* 履歴・分析モーダル */}
      {showHistory && <HistoryModal db={db} appId={appId} devices={devices} wardList={wardList} onClose={() => setShowHistory(false)} onDownloadCSV={handleDownloadCSV} />}

      {/* 個別機器履歴モーダル */}
      {historyTargetDevice && (
          <DeviceHistoryModal 
            db={db} 
            appId={appId} 
            device={historyTargetDevice} 
            onClose={() => setHistoryTargetDevice(null)} 
          />
      )}
    </div>
  );
}

// --- Sub Components ---

// DeviceRow: リストの各行コンポーネント。クリックでインラインフォームを展開。
function DeviceRow({ device, record, otherTodayRecords = [], isExpanded, onToggle, onSave, onDelete, onShowHistory, checker, isFirst, isLast, date }) {
  const isChecked = !!record;
  const hasOtherTodayRecord = otherTodayRecords.length > 0;
  const otherWardsLabel = Array.from(new Set(otherTodayRecords.map(r => r.ward).filter(Boolean))).join('・');
  const rowRef = useRef(null);
  
  // 展開時に自動スクロール
  useEffect(() => {
    if (isExpanded && rowRef.current) {
      setTimeout(() => {
        rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  }, [isExpanded]);

  // ステータス判定（不具合・備考の有無）
  let hasIssue = false;
  let hasNote = false;
  if (record) {
    if (record.inUse === 'YES' && record.reception === 'BAD') hasIssue = true;
    if (record.inUse === 'NO' && (record.isBroken === 'YES' || record.channelCheck === 'NG')) hasIssue = true;
    if (record.note && record.note.trim() !== '') hasNote = true;
  }

  // 背景色決定
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
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xl font-bold font-mono ${isChecked ? (hasIssue ? 'text-red-700' : (hasNote ? 'text-orange-700' : 'text-green-700')) : 'text-gray-800'}`}>ch: {device.id}</span>
            {isChecked && !hasIssue && <CheckCircle size={18} className={hasNote ? 'text-orange-500' : 'text-green-600'} />}
            {hasIssue && <AlertTriangle size={18} className="text-red-500" />}
            {hasOtherTodayRecord && (
              <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">
                本日「{otherWardsLabel}」で点検済
              </span>
            )}
            
            {/* 詳細履歴アイコンボタン */}
            <button 
                onClick={(e) => { e.stopPropagation(); onShowHistory(); }} 
                className="ml-1 p-1.5 rounded-full text-gray-400 hover:bg-blue-100 hover:text-blue-600 transition-colors"
                title="過去の履歴を表示"
            >
                <Info size={18} />
            </button>
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

      {isExpanded && (
        <div className="border-t border-blue-100 p-4 bg-white rounded-b-lg animate-slide-up">
            {hasOtherTodayRecord && (
              <div className="mb-4 p-2.5 rounded-lg bg-indigo-50 border border-indigo-200 text-xs text-indigo-800">
                <strong>同日移動の履歴あり:</strong> 本日すでに「{otherTodayRecords.map(r => `${r.ward} / ${r.monitorGroup}`).join('、')}」で点検記録があります。ここで保存すると、移動前の記録も残したまま現在の病棟（{device.ward}）の点検記録が追加保存され、<strong>両方の記録が残ります</strong>。
              </div>
            )}
            <CheckInlineForm 
                device={device}
                initialData={record}
                checker={checker}
                onClose={onToggle}
                onSave={onSave}
                onDelete={onDelete}
                isFirst={isFirst} 
                isLast={isLast}
                date={date}
            />
        </div>
      )}
    </div>
  );
}

// CheckInlineForm: 実際の入力フォームコンポーネント
function CheckInlineForm({ device, initialData, checker, onClose, onSave, onDelete, isFirst, isLast, date }) {
  const [inUse, setInUse] = useState(initialData?.inUse || null);
  const [reception, setReception] = useState(initialData?.reception || 'GOOD');
  const [receptionReason, setReceptionReason] = useState(initialData?.receptionReason || 'A');
  const [receptionNote, setReceptionNote] = useState(initialData?.receptionNote || '');
  const [isBroken, setIsBroken] = useState(initialData?.isBroken || '-');
  const [channelCheck, setChannelCheck] = useState(initialData?.channelCheck || '-');
  const [note, setNote] = useState(initialData?.note || '');

  // 既存データがある場合の初期化
  useEffect(() => {
    setInUse(initialData?.inUse || null);
    setReception(initialData?.reception || 'GOOD');
    setReceptionReason(initialData?.receptionReason || 'A');
    setReceptionNote(initialData?.receptionNote || '');
    setIsBroken(initialData?.isBroken || '-');
    setChannelCheck(initialData?.channelCheck || '-');
    setNote(initialData?.note || '');
  }, [initialData]);

  // 使用状況に応じた項目の自動リセット
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
      date: date,
      timestamp: new Date().toLocaleString('ja-JP'), checker: checker || '',
      inUse, reception: inUse === 'YES' ? reception : '-',
      receptionReason: (inUse === 'YES' && reception === 'BAD') ? receptionReason : null,
      receptionNote: (inUse === 'YES' && reception === 'BAD' && receptionReason === 'D') ? receptionNote : null,
      isBroken: inUse === 'NO' ? isBroken : '-', channelCheck: inUse === 'NO' ? channelCheck : '-',
      note
    };
  };

  const handleSave = () => {
    // 修正: 保存後も閉じないようにアクションを'STAY'に変更
    onSave(createRecord(), 'STAY'); 
  };
  
  const handleSaveAndNext = () => {
    if (isLast) return;
    onSave(createRecord(), 'NEXT'); 
  };

  const handleSaveAndPrev = () => {
    if (isFirst) return;
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

      {/* アクションボタン: 左から「戻る」「取消」「保存」「次へ」 */}
      <div className="pt-2 grid grid-cols-4 gap-3">
        {/* 戻る */}
        <button onClick={handleSaveAndPrev} disabled={isFirst} className={`col-span-1 py-4 rounded-xl flex justify-center items-center transition-all ${isFirst ? 'bg-gray-100 text-gray-300 cursor-not-allowed' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 active:scale-95'}`}>
            <ArrowLeft size={24}/>
        </button>

        {/* 取消 */}
        <div className="col-span-1">
             {initialData ? (
                <button onClick={() => onDelete(initialData)} className="w-full py-4 bg-red-50 text-red-500 rounded-xl flex justify-center items-center hover:bg-red-100 active:scale-95 transition-all">
                    <Trash2 size={24} />
                </button>
            ) : (
                <div className="w-full h-full bg-gray-50 rounded-xl"></div>
            )}
        </div>

        {/* 保存 */}
        <button onClick={handleSave} className="col-span-1 py-4 bg-blue-500 text-white rounded-xl flex justify-center items-center hover:bg-blue-600 active:scale-95 transition-all shadow-sm">
            <Save size={24}/>
        </button>
        
        {/* 次へ */}
        <button onClick={handleSaveAndNext} disabled={isLast} className={`col-span-1 py-4 rounded-xl flex justify-center items-center transition-all ${isLast ? 'bg-gray-100 text-gray-300 cursor-not-allowed' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 active:scale-95'}`}>
            <ArrowRight size={24}/>
        </button>
      </div>
    </div>
  );
}

// SelectionButton: チェックボックス代わりの選択ボタン
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
// SettingsModal: マスタ管理モーダル
// --------------------------------------------------------------------------------------
function SettingsModal({ devices, staffList, transmitterModels, wardList, monitorList, onClose }) {
  const [activeTab, setActiveTab] = useState('DEVICE');
  
  // 機器マスタ保存・論理削除・復元・完全削除
  const handleSaveDevice = async (device) => {
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'devices', device.id), device);
  };
  const handleDeleteDevice = async (id) => {
    if (confirm(`ch:${id} を削除しますか？\n（※所属モニタはそのまま残り、過去の点検記録も保持されます）`)) {
      const targetDevice = devices.find(d => d.id === id);
      if (targetDevice?.ward && targetDevice?.monitorGroup) {
        const monitorDocId = encodeURIComponent(`${targetDevice.ward}__${targetDevice.monitorGroup}`);
        await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'monitors', monitorDocId), {
          ward: targetDevice.ward,
          name: targetDevice.monitorGroup,
          isDeleted: false,
          updatedAt: getTodayString()
        });
      }
      await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'devices', id), {
        isDeleted: true,
        deletedAt: getTodayString()
      }, { merge: true });
    }
  };
  const handleRestoreDevice = async (id) => {
    const targetDevice = devices.find(d => d.id === id);
    const locationLabel = targetDevice ? `「${targetDevice.ward} / ${targetDevice.monitorGroup}」` : '元の所属先';
    if (!confirm(`ch:${id} を元所属 ${locationLabel} に復元しますか？\n（※別の病棟やモニタへ移動して復元したい場合は、キャンセルして「移動して復元」を押してください）`)) {
      return;
    }
    if (targetDevice?.ward && targetDevice?.monitorGroup) {
      const monitorDocId = encodeURIComponent(`${targetDevice.ward}__${targetDevice.monitorGroup}`);
      await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'monitors', monitorDocId), {
        ward: targetDevice.ward,
        name: targetDevice.monitorGroup,
        isDeleted: false,
        updatedAt: getTodayString()
      });
    }
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'devices', id), {
      isDeleted: false,
      deletedAt: null
    }, { merge: true });
  };
  const handlePermanentDeleteDevice = async (id, skipConfirm = false) => {
    if (skipConfirm || confirm(`ch:${id} のマスタデータを完全に削除しますか？`)) {
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'devices', id));
    }
  };

  // スタッフマスタ保存・削除
  const handleSaveStaff = async (staff) => {
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'staff', staff.id), staff);
  };
  const handleDeleteStaff = async (id) => {
    if(confirm('本当に削除しますか？')) await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'staff', id));
  };

  // 型番マスタ保存・削除（型番名変更時は既存の送信機・モニタ・過去の点検記録の型番表記も一括更新し、月報で行が分裂するのを防ぐ）
  const handleSaveModel = async (model, oldModel = null) => {
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'transmitter_models', model.id), model);

    if (oldModel && oldModel.name && oldModel.name !== model.name) {
      const updates = [];

      if (model.type === 'TRANSMITTER') {
        devices.forEach(d => {
          if (d.model === oldModel.name) {
            updates.push({
              type: 'update',
              ref: doc(db, 'artifacts', appId, 'public', 'data', 'devices', d.id),
              data: { model: model.name }
            });
          }
        });

        try {
          const checksQ = query(
            collection(db, 'artifacts', appId, 'public', 'data', 'checks'),
            where('model', '==', oldModel.name)
          );
          const checksSnap = await getDocs(checksQ);
          checksSnap.docs.forEach(checkDoc => {
            updates.push({
              type: 'update',
              ref: doc(db, 'artifacts', appId, 'public', 'data', 'checks', checkDoc.id),
              data: { model: model.name }
            });
          });
        } catch (e) {
          console.error('Failed to cascade transmitter model rename to checks:', e);
        }
      } else if (model.type === 'MONITOR') {
        const oldPrefix = `${oldModel.name} (`;
        const replaceMonitorName = (name) => {
          if (name === oldModel.name) return model.name;
          if (name && name.startsWith(oldPrefix)) {
            return `${model.name} (${name.slice(oldPrefix.length)}`;
          }
          return null;
        };

        devices.forEach(d => {
          const updatedGroup = replaceMonitorName(d.monitorGroup);
          if (updatedGroup) {
            updates.push({
              type: 'update',
              ref: doc(db, 'artifacts', appId, 'public', 'data', 'devices', d.id),
              data: { monitorGroup: updatedGroup }
            });
          }
        });

        monitorList.forEach(m => {
          const updatedName = replaceMonitorName(m.name);
          if (updatedName && m.ward) {
            const oldDocId = encodeURIComponent(`${m.ward}__${m.name}`);
            const newDocId = encodeURIComponent(`${m.ward}__${updatedName}`);
            if (oldDocId !== newDocId) {
              updates.push({
                type: 'set',
                ref: doc(db, 'artifacts', appId, 'public', 'data', 'monitors', oldDocId),
                data: {
                  ward: m.ward,
                  name: m.name,
                  isLoaner: Boolean(m.isLoaner),
                  isDeleted: true,
                  deletedAt: getTodayString()
                }
              });
              updates.push({
                type: 'set',
                ref: doc(db, 'artifacts', appId, 'public', 'data', 'monitors', newDocId),
                data: {
                  ward: m.ward,
                  name: updatedName,
                  isLoaner: Boolean(m.isLoaner),
                  isDeleted: false,
                  updatedAt: getTodayString()
                }
              });
            }
          }
        });

        try {
          const allChecksSnap = await getDocs(query(collection(db, 'artifacts', appId, 'public', 'data', 'checks')));
          allChecksSnap.docs.forEach(checkDoc => {
            const data = checkDoc.data();
            const updatedGroup = replaceMonitorName(data.monitorGroup);
            if (updatedGroup) {
              updates.push({
                type: 'update',
                ref: doc(db, 'artifacts', appId, 'public', 'data', 'checks', checkDoc.id),
                data: { monitorGroup: updatedGroup }
              });
            }
          });
        } catch (e) {
          console.error('Failed to cascade monitor model rename to checks:', e);
        }
      }

      if (updates.length > 0) {
        await commitBatchUpdates(db, updates);
      }
    }
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
            <DeviceMasterEditor
              list={devices}
              models={transmitterModels}
              wardList={wardList}
              monitorList={monitorList}
              onSave={handleSaveDevice}
              onDelete={handleDeleteDevice}
              onRestore={handleRestoreDevice}
              onPermanentDelete={handlePermanentDeleteDevice}
            />
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

// DeviceMasterEditor: 機器マスタ編集（ドラッグ&ドロップ並び替え、一括追加、病棟間移動、論理削除管理、単体モニタ登録機能付き）
function DeviceMasterEditor({ list, models, wardList, monitorList = [], onSave, onDelete, onRestore, onPermanentDelete }) {
  const [addMode, setAddMode] = useState(null);
  const [addStep, setAddStep] = useState(1);
  const [newDeviceBase, setNewDeviceBase] = useState({ ward: '', monitorGroup: '' });
  const [deviceRows, setDeviceRows] = useState([{id: '', model: ''}]);
  const [monitorMode, setMonitorMode] = useState('EXISTING');
  const [newMonitorModel, setNewMonitorModel] = useState('');
  const [newMonitorSerial, setNewMonitorSerial] = useState('');
  const [newMonitorIsLoaner, setNewMonitorIsLoaner] = useState(false);
  const [step3Tab, setStep3Tab] = useState('NEW'); // 'NEW' | 'MOVE_EXISTING'
  const [selectedMoveIds, setSelectedMoveIds] = useState([]);
  const [moveFilterWard, setMoveFilterWard] = useState('ALL');
  const [moveSearchText, setMoveSearchText] = useState('');
  const [editItem, setEditItem] = useState(null);
  const [originalId, setOriginalId] = useState('');
  const [editWardMode, setEditWardMode] = useState('EXISTING');
  const [editMonitorMode, setEditMonitorMode] = useState('EXISTING');
  const [editNewMonitorModel, setEditNewMonitorModel] = useState('');
  const [editNewMonitorSerial, setEditNewMonitorSerial] = useState('');
  const [filterText, setFilterText] = useState('');
  const [editingMonitor, setEditingMonitor] = useState(null);
  const [draggedItem, setDraggedItem] = useState(null);
  const [expandedWards, setExpandedWards] = useState({});
  const [showDeletedDevices, setShowDeletedDevices] = useState(false);

  // Ward DnD State
  const [draggedWard, setDraggedWard] = useState(null);
  const touchWardRef = useRef(null); // 病棟タッチ用Ref

  const transmitterModelsList = useMemo(() => models.filter(m => m.type === 'TRANSMITTER'), [models]);
  const monitorModelsList = useMemo(() => models.filter(m => m.type === 'MONITOR'), [models]);

  // 指定モニタが貸出機かどうか判定するヘルパー
  const isMonitorLoaner = (ward, monitorName) => {
    if (isStandbyWard(ward)) return true;
    return monitorList.some(m => m.name === monitorName && m.isLoaner);
  };

  // モニタマスタ用ドキュメントID生成・保存・削除ヘルパー
  const getMonitorDocId = (ward, monitorName) => encodeURIComponent(`${ward}__${monitorName}`);

  const saveMonitorDoc = async (ward, monitorName, options = {}) => {
    const trimmedWard = (ward || '').trim();
    const trimmedMonitor = (monitorName || '').trim();
    if (!trimmedWard || !trimmedMonitor) return;
    const docId = getMonitorDocId(trimmedWard, trimmedMonitor);
    const shouldBeLoaner = options.isLoaner !== undefined
      ? Boolean(options.isLoaner)
      : isMonitorLoaner(trimmedWard, trimmedMonitor);
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'monitors', docId), {
      ward: trimmedWard,
      name: trimmedMonitor,
      isLoaner: shouldBeLoaner,
      isDeleted: false,
      updatedAt: getTodayString()
    });
    if (!wardList.some(w => w.name === trimmedWard)) {
      const maxWardSort = wardList.length > 0 ? Math.max(...wardList.map(w => w.sortOrder || 0)) : 0;
      await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'wards', trimmedWard), {
        name: trimmedWard,
        sortOrder: maxWardSort + 1
      });
    }
  };

  const handleDeleteEmptyMonitor = async (ward, monitorName) => {
    if (!confirm(`モニタ「${ward} / ${monitorName}」を削除しますか？`)) return;
    const docId = getMonitorDocId(ward, monitorName);
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'monitors', docId), {
      ward,
      name: monitorName,
      isLoaner: isMonitorLoaner(ward, monitorName),
      isDeleted: true,
      deletedAt: getTodayString()
    });
  };

  useEffect(() => {
    if (transmitterModelsList.length > 0) {
      setDeviceRows(prev => prev.map(row => row.model ? row : { ...row, model: transmitterModelsList[0].name }));
    }
  }, [transmitterModelsList]);

  // 有効な機器と削除済み機器を分離
  const activeList = useMemo(() => list.filter(d => !d.isDeleted), [list]);
  const deletedList = useMemo(() => {
    return list
      .filter(d => d.isDeleted)
      .sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.id.localeCompare(b.id));
  }, [list]);

  // リストのソートとフィルタリング（有効な機器のみ）
  const displayList = useMemo(() => {
    let sorted = [...activeList].sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.id.localeCompare(b.id));
    if (!filterText) return sorted;
    return sorted.filter((d) => d.id.includes(filterText) || d.monitorGroup.includes(filterText) || d.ward.includes(filterText));
  }, [activeList, filterText]);

  // 機器追加・移動時の病棟リストをマスタ順(wardListのsortOrder)にソート（貸出機待機用の「ME室」を常時選択可能にする）
  const allWards = useMemo(() => {
    const uniqueWards = Array.from(new Set([
      ...activeList.map((d) => d.ward),
      ...monitorList.map((m) => m.ward),
      ...wardList.map((w) => w.name),
      'ME室'
    ])).filter(Boolean);
    
    return uniqueWards.sort((a, b) => {
      const wa = wardList.find(w => w.name === a);
      const wb = wardList.find(w => w.name === b);
      
      const orderA = wa ? (wa.sortOrder ?? 9999) : (isStandbyWard(a) ? 99999 : 9999);
      const orderB = wb ? (wb.sortOrder ?? 9999) : (isStandbyWard(b) ? 99999 : 9999);
      
      if (orderA !== orderB) return orderA - orderB;
      return a.localeCompare(b);
    });
  }, [activeList, monitorList, wardList]);

  const getMonitorsByWard = (ward) => {
    const wardDevices = activeList.filter((d) => d.ward === ward);
    const wardMonitors = monitorList.filter((m) => m.ward === ward);
    return Array.from(new Set([
      ...wardDevices.map((d) => d.monitorGroup),
      ...wardMonitors.map((m) => m.name)
    ])).filter(Boolean);
  };

  const toggleWard = (ward) => setExpandedWards(prev => ({ ...prev, [ward]: !prev[ward] }));

  // 新規追加フロー開始
  const startFlow = (mode) => {
    setNewDeviceBase({ ward: '', monitorGroup: '' });
    const defaultModel = transmitterModelsList.length > 0 ? transmitterModelsList[0].name : '';
    setDeviceRows([{id: '', model: defaultModel}]); 
    setMonitorMode('EXISTING');
    setNewMonitorModel(monitorModelsList.length > 0 ? monitorModelsList[0].name : '');
    setNewMonitorSerial('');
    setNewMonitorIsLoaner(false);
    setStep3Tab(mode === 'MONITOR' ? 'MOVE_EXISTING' : 'NEW');
    setSelectedMoveIds([]);
    setMoveFilterWard('ALL');
    setMoveSearchText('');
    setAddMode(mode);
    if (mode === 'WARD') { setAddStep(1); } 
    else if (mode === 'MONITOR') { setAddStep(1); setMonitorMode('NEW'); } 
    else if (mode === 'DEVICE') { setAddStep(1); setMonitorMode('EXISTING'); }
  };

  const handleNextStep = () => {
    if (addStep === 1 && !newDeviceBase.ward) return alert('病棟を選択または入力してください');
    if (addStep === 1 && isStandbyWard(newDeviceBase.ward)) {
      setNewMonitorIsLoaner(true);
    }
    if (addStep === 2) {
      if (monitorMode === 'EXISTING' && !newDeviceBase.monitorGroup) return alert('モニタを選択してください');
      if (monitorMode === 'NEW') {
        if (!newMonitorModel || !newMonitorSerial.trim()) return alert('モニタ型番と製造番号を入力してください');
        const groupName = `${newMonitorModel} (${newMonitorSerial.trim()})`;
        setNewDeviceBase(prev => ({ ...prev, monitorGroup: groupName }));
      }
    }
    setAddStep(prev => prev + 1);
  };

  // Step 2 から直接モニタ単体で登録完了するハンドラ
  const handleCompleteMonitorOnly = async () => {
    if (!newDeviceBase.ward) return alert('病棟を選択または入力してください');
    let groupName = newDeviceBase.monitorGroup;
    if (monitorMode === 'NEW') {
      if (!newMonitorModel || !newMonitorSerial.trim()) return alert('モニタ型番と製造番号を入力してください');
      groupName = `${newMonitorModel} (${newMonitorSerial.trim()})`;
    } else if (!groupName) {
      return alert('モニタを選択してください');
    }

    const isLoanerFlag = newMonitorIsLoaner || isStandbyWard(newDeviceBase.ward);
    await saveMonitorDoc(newDeviceBase.ward, groupName, { isLoaner: isLoanerFlag });
    setExpandedWards(prev => ({ ...prev, [newDeviceBase.ward]: true }));
    alert(`モニタ「${newDeviceBase.ward} / ${groupName}」${isLoanerFlag ? '（貸出機）' : ''}を単体で登録しました。\n（既存のモニタからchを選択して移動させることができます）`);
    setAddMode(null);
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

  const toggleSelectMoveId = (id) => {
    setSelectedMoveIds(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]);
  };

  // 新規登録・既存ch移動・モニタ単体登録の実行（重複chチェック・確認付き）
  const handleCompleteAdd = async () => {
    const validRows = deviceRows.filter(r => r.id.trim() !== '');
    const moveDevices = activeList.filter(d => selectedMoveIds.includes(d.id));
    const isLoanerFlag = monitorMode === 'NEW'
      ? (newMonitorIsLoaner || isStandbyWard(newDeviceBase.ward))
      : isMonitorLoaner(newDeviceBase.ward, newDeviceBase.monitorGroup);

    // chが1件も入力・選択されていない場合
    if (validRows.length === 0 && moveDevices.length === 0) {
      if (addMode === 'MONITOR' || addMode === 'WARD' || monitorMode === 'NEW') {
        await saveMonitorDoc(newDeviceBase.ward, newDeviceBase.monitorGroup, { isLoaner: isLoanerFlag });
        setExpandedWards(prev => ({ ...prev, [newDeviceBase.ward]: true }));
        alert(`モニタ「${newDeviceBase.ward} / ${newDeviceBase.monitorGroup}」${isLoanerFlag ? '（貸出機）' : ''}を単体で登録しました`);
        setAddMode(null);
        return;
      }
      return alert('新規chを入力するか、移動する既存のchを選択してください');
    }

    // 同一登録画面内での重複入力チェック
    const seenIds = new Set();
    const duplicatedInInput = new Set();
    for (const row of validRows) {
      const trimmed = row.id.trim();
      if (seenIds.has(trimmed)) {
        duplicatedInInput.add(trimmed);
      }
      seenIds.add(trimmed);
    }
    if (duplicatedInInput.size > 0) {
      return alert(`同じch（${Array.from(duplicatedInInput).join(', ')}）が複数行に入力されています。\n重複を解消してから登録してください。`);
    }

    // 新規手入力したchのうち、選択移動対象に含まれていない既存機器との重複チェック
    const existingConflicts = [];
    for (const row of validRows) {
      const trimmed = row.id.trim();
      if (selectedMoveIds.includes(trimmed)) continue;
      const found = list.find(d => d.id === trimmed);
      if (found) {
        existingConflicts.push(found);
      }
    }

    if (existingConflicts.length > 0) {
      const conflictLines = existingConflicts.map(d =>
        d.isDeleted
          ? `・ch:${d.id}（削除済み機器 / 旧所属: ${d.ward} - ${d.monitorGroup}）`
          : `・ch:${d.id}（現在: ${d.ward} / ${d.monitorGroup}）`
      ).join('\n');

      const confirmMsg = existingConflicts.length === 1
        ? `このch（ch:${existingConflicts[0].id}）はすでに${
            existingConflicts[0].isDeleted
              ? `削除済み機器（旧: ${existingConflicts[0].ward} / ${existingConflicts[0].monitorGroup}）`
              : `「${existingConflicts[0].ward} / ${existingConflicts[0].monitorGroup}」`
          }に存在します。登録しますか？\n\n（※OKを押すと「${newDeviceBase.ward} / ${newDeviceBase.monitorGroup}」へ移動・上書き登録されます）`
        : `以下のchはすでに存在します。登録しますか？\n\n${conflictLines}\n\n（※OKを押すと「${newDeviceBase.ward} / ${newDeviceBase.monitorGroup}」へ移動・上書き登録されます）`;

      if (!confirm(confirmMsg)) return;
    }

    // モニタ自体もマスタに保存（後から全chを他へ移動してもモニタが消えないように保持）
    await saveMonitorDoc(newDeviceBase.ward, newDeviceBase.monitorGroup, { isLoaner: isLoanerFlag });

    let currentMaxSort = list.length > 0 ? Math.max(...list.map((d) => d.sortOrder || 0)) : 0;

    // 1. 新規手入力分の保存
    for (const row of validRows) {
      const trimmed = row.id.trim();
      const existingDevice = list.find(d => d.id === trimmed);
      if (existingDevice && !existingDevice.isDeleted && existingDevice.ward && existingDevice.monitorGroup) {
        await saveMonitorDoc(existingDevice.ward, existingDevice.monitorGroup);
      }
      currentMaxSort++;
      const newDevice = {
        ...newDeviceBase,
        id: trimmed,
        model: row.model,
        sortOrder: existingDevice?.sortOrder ?? currentMaxSort,
        isDeleted: false,
        deletedAt: null
      };
      await onSave(newDevice);
    }

    // 2. 既存モニタから選択したchの移動（一括更新）
    for (const dev of moveDevices) {
      // 手入力側にも同じchがあった場合は二重保存を避ける
      if (validRows.some(r => r.id.trim() === dev.id)) continue;
      if (dev.ward && dev.monitorGroup) {
        await saveMonitorDoc(dev.ward, dev.monitorGroup);
      }
      currentMaxSort++;
      const movedDevice = {
        ...dev,
        ward: newDeviceBase.ward,
        monitorGroup: newDeviceBase.monitorGroup,
        sortOrder: currentMaxSort,
        isDeleted: false,
        deletedAt: null
      };
      await onSave(movedDevice);
    }

    setExpandedWards(prev => ({ ...prev, [newDeviceBase.ward]: true }));

    const msgParts = [];
    if (validRows.length > 0) msgParts.push(`新規登録: ${validRows.length}件`);
    if (moveDevices.length > 0) msgParts.push(`他モニタからの移動: ${moveDevices.length}件`);
    alert(`「${newDeviceBase.ward} / ${newDeviceBase.monitorGroup}」へ保存しました（${msgParts.join('、')}）`);
    setAddMode(null);
  };

  // 送信機の編集・病棟／モニタ移動
  const handleStartEdit = (device) => {
    setEditItem({ ...device });
    setOriginalId(device.id);
    setEditWardMode('EXISTING');
    setEditMonitorMode('EXISTING');
    setEditNewMonitorModel(monitorModelsList.length > 0 ? monitorModelsList[0].name : '');
    setEditNewMonitorSerial('');
  };

  const handleEditWardChange = (newWard) => {
    const monitors = getMonitorsByWard(newWard);
    if (monitors.length > 0) {
      setEditMonitorMode('EXISTING');
      setEditItem(prev => ({
        ...prev,
        ward: newWard,
        monitorGroup: monitors.includes(prev.monitorGroup) ? prev.monitorGroup : monitors[0]
      }));
    } else {
      setEditMonitorMode('NEW');
      setEditItem(prev => ({ ...prev, ward: newWard, monitorGroup: '' }));
    }
  };

  const handleUpdate = async () => {
    if (!editItem) return;
    const trimmedId = editItem.id.trim();
    const trimmedWard = (editItem.ward || '').trim();
    if (!trimmedId) return alert('chを入力してください');
    if (!trimmedWard) return alert('病棟を選択または入力してください');

    let targetMonitorGroup = editItem.monitorGroup;
    if (editMonitorMode === 'NEW') {
      if (!editNewMonitorModel || !editNewMonitorSerial.trim()) {
        return alert('移動先の新規モニタ型番と製造番号を入力してください');
      }
      targetMonitorGroup = `${editNewMonitorModel} (${editNewMonitorSerial.trim()})`;
    } else if (!targetMonitorGroup) {
      return alert('モニタを選択してください');
    }

    // ch番号が変更された場合の重複チェック・確認
    if (trimmedId !== originalId) {
      const existingDevice = list.find(d => d.id === trimmedId);
      if (existingDevice) {
        const locationDesc = existingDevice.isDeleted
          ? `削除済み機器（旧: ${existingDevice.ward} / ${existingDevice.monitorGroup}）`
          : `「${existingDevice.ward} / ${existingDevice.monitorGroup}」`;
        const confirmMsg = `このch（ch:${trimmedId}）はすでに${locationDesc}に存在します。登録（上書き）しますか？\n\n（※OKを押すと既存の ch:${trimmedId} が「${trimmedWard} / ${targetMonitorGroup}」へ上書きされます）`;
        if (!confirm(confirmMsg)) return;
      }
    }

    await saveMonitorDoc(trimmedWard, targetMonitorGroup);
    const originalDevice = list.find(d => d.id === originalId);
    if (originalDevice && !originalDevice.isDeleted && originalDevice.ward && originalDevice.monitorGroup) {
      // 移動元のモニタも消えないようmonitorsコレクションに保持
      await saveMonitorDoc(originalDevice.ward, originalDevice.monitorGroup);
    }

    const updatedDevice = {
      ...editItem,
      id: trimmedId,
      ward: trimmedWard,
      monitorGroup: targetMonitorGroup,
      isDeleted: false,
      deletedAt: null
    };

    if (trimmedId !== originalId) {
      await onSave(updatedDevice);
      await onPermanentDelete(originalId, true);
    } else {
      await onSave(updatedDevice);
    }
    setEditItem(null);
    setOriginalId('');
  };

  // モニタ名変更・モニタごとの病棟移動（関連デバイス一括更新＋単体モニタ＋貸出機フラグ対応）
  const handleUpdateMonitorName = async () => {
    if (!editingMonitor || !editingMonitor.model || !editingMonitor.serial.trim()) {
      return alert('モニタ型番と製造番号を入力してください');
    }
    const newWard = (editingMonitor.ward || '').trim();
    if (!newWard) return alert('所属病棟を選択または入力してください');

    const newName = `${editingMonitor.model} (${editingMonitor.serial.trim()})`;
    const nextIsLoaner = Boolean(editingMonitor.isLoaner || isStandbyWard(newWard));
    const isWardChanged = newWard !== editingMonitor.oldWard;
    const isNameChanged = newName !== editingMonitor.oldName;
    const isLoanerChanged = nextIsLoaner !== Boolean(editingMonitor.oldIsLoaner);

    if (!isWardChanged && !isNameChanged && !isLoanerChanged) {
      setEditingMonitor(null);
      return;
    }

    const targets = activeList.filter(
      (d) => d.ward === editingMonitor.oldWard && d.monitorGroup === editingMonitor.oldName
    );

    const confirmMsg = isWardChanged
      ? `モニタ「${editingMonitor.oldName}」${targets.length > 0 ? `と紐付く送信機（${targets.length}台）` : ''}を\n「${editingMonitor.oldWard}」→「${newWard} / ${newName}」へ移動・更新します。\nよろしいですか？`
      : isNameChanged
        ? `「${editingMonitor.oldName}」を「${newName}」に変更します。\n${targets.length > 0 ? `紐付いている全ての送信機（${targets.length}台）が更新されますが` : ''}よろしいですか？`
        : `モニタ「${newName}」の設定を更新します。よろしいですか？`;

    if (!confirm(confirmMsg)) return;

    const batch = writeBatch(db);
    if (isWardChanged || isNameChanged) {
      targets.forEach((d) => {
        batch.update(doc(db, 'artifacts', appId, 'public', 'data', 'devices', d.id), {
          ward: newWard,
          monitorGroup: newName
        });
      });
    }

    // モニタマスタ（monitorsコレクション）の更新
    const oldMonitorDocId = getMonitorDocId(editingMonitor.oldWard, editingMonitor.oldName);
    const newMonitorDocId = getMonitorDocId(newWard, newName);
    if (oldMonitorDocId !== newMonitorDocId) {
      batch.set(doc(db, 'artifacts', appId, 'public', 'data', 'monitors', oldMonitorDocId), {
        ward: editingMonitor.oldWard,
        name: editingMonitor.oldName,
        isLoaner: nextIsLoaner,
        isDeleted: true,
        deletedAt: getTodayString()
      });
    }
    batch.set(doc(db, 'artifacts', appId, 'public', 'data', 'monitors', newMonitorDocId), {
      ward: newWard,
      name: newName,
      isLoaner: nextIsLoaner,
      isDeleted: false,
      updatedAt: getTodayString()
    });

    if (!wardList.some(w => w.name === newWard)) {
      const maxWardSort = wardList.length > 0 ? Math.max(...wardList.map(w => w.sortOrder || 0)) : 0;
      batch.set(doc(db, 'artifacts', appId, 'public', 'data', 'wards', newWard), {
        name: newWard,
        sortOrder: maxWardSort + 1
      });
    }

    await batch.commit();

    // モニタ名（型番・製造番号）を変更した場合、過去の点検記録(checks)のmonitorGroup名も統一して月報で行が2行に分裂するのを防ぐ
    if (isNameChanged) {
      try {
        const checksQ = query(
          collection(db, 'artifacts', appId, 'public', 'data', 'checks'),
          where('monitorGroup', '==', editingMonitor.oldName)
        );
        const checksSnap = await getDocs(checksQ);
        const checkUpdates = [];
        checksSnap.docs.forEach(checkDoc => {
          const rData = checkDoc.data();
          // 同一モニタ（旧所属病棟または病棟未指定）の記録のモニタ名を新名称へ統一（当時のward自体は変更しない）
          if (!rData.ward || rData.ward === editingMonitor.oldWard || !isWardChanged) {
            checkUpdates.push({
              type: 'update',
              ref: doc(db, 'artifacts', appId, 'public', 'data', 'checks', checkDoc.id),
              data: { monitorGroup: newName }
            });
          }
        });
        if (checkUpdates.length > 0) {
          await commitBatchUpdates(db, checkUpdates);
        }
      } catch (e) {
        console.error('Failed to cascade monitor rename to checks:', e);
      }
    }

    setExpandedWards(prev => ({ ...prev, [newWard]: true }));
    setEditingMonitor(null);
  };

  // 貸出機モニタをワンタップで「ME室」へ返却するハンドラ
  const handleReturnMonitorToME = async (ward, monitorName) => {
    const targets = activeList.filter(d => d.ward === ward && d.monitorGroup === monitorName);
    const confirmMsg = `貸出機モニタ「${monitorName}」${targets.length > 0 ? `（紐付く送信機 ${targets.length}台を含む）` : ''}を\n「${ward}」から「ME室（待機・点検対象外）」へ返却しますか？`;
    if (!confirm(confirmMsg)) return;

    const batch = writeBatch(db);
    targets.forEach(d => {
      batch.update(doc(db, 'artifacts', appId, 'public', 'data', 'devices', d.id), {
        ward: 'ME室',
        monitorGroup: monitorName
      });
    });

    const oldMonitorDocId = getMonitorDocId(ward, monitorName);
    const newMonitorDocId = getMonitorDocId('ME室', monitorName);
    if (oldMonitorDocId !== newMonitorDocId) {
      batch.set(doc(db, 'artifacts', appId, 'public', 'data', 'monitors', oldMonitorDocId), {
        ward,
        name: monitorName,
        isLoaner: true,
        isDeleted: true,
        deletedAt: getTodayString()
      });
    }
    batch.set(doc(db, 'artifacts', appId, 'public', 'data', 'monitors', newMonitorDocId), {
      ward: 'ME室',
      name: monitorName,
      isLoaner: true,
      isDeleted: false,
      updatedAt: getTodayString()
    });

    if (!wardList.some(w => w.name === 'ME室')) {
      const maxWardSort = wardList.length > 0 ? Math.max(...wardList.map(w => w.sortOrder || 0)) : 0;
      batch.set(doc(db, 'artifacts', appId, 'public', 'data', 'wards', 'ME室'), {
        name: 'ME室',
        sortOrder: maxWardSort + 1
      });
    }

    await batch.commit();
    setExpandedWards(prev => ({ ...prev, 'ME室': true }));
  };

  // --- Device DnD Handlers (機器の並び替え) ---
  const handleDragStart = (e, item) => { 
    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) {
      e.preventDefault();
      return;
    }
    e.stopPropagation();
    setDraggedItem(item); 
    if ('dataTransfer' in e) e.dataTransfer.effectAllowed = 'move'; 
  };
  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const handleDrop = async (e, targetItem, sourceItem = draggedItem) => {
    e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    if (!sourceItem || sourceItem.id === targetItem.id) return;
    if (sourceItem.monitorGroup !== targetItem.monitorGroup) return;
    
    // 現在の表示順（sortOrder → id順）リストを取得
    const currentList = [...activeList].sort(
      (a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.id.localeCompare(b.id)
    );

    const fromIndex = currentList.findIndex(item => item.id === sourceItem.id);
    const toIndex = currentList.findIndex(item => item.id === targetItem.id);

    if (fromIndex === -1 || toIndex === -1) return;

    // 配列内でアイテムを移動
    const newList = [...currentList];
    const [movedItem] = newList.splice(fromIndex, 1);
    newList.splice(toIndex, 0, movedItem);

    // 新しい順序で連番を振り直して保存（差分があるもののみ更新）
    const batch = writeBatch(db);
    newList.forEach((item, index) => {
      const newOrder = index + 1;
      if (item.sortOrder !== newOrder) {
        batch.update(doc(db, 'artifacts', appId, 'public', 'data', 'devices', item.id), { sortOrder: newOrder });
      }
    });

    await batch.commit();
    setDraggedItem(null);
  };

  // --- Ward DnD Handlers (病棟の並び替え) ---
  const handleWardDragStart = (e, ward) => {
    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) {
    }
    setDraggedWard(ward);
    if ('dataTransfer' in e) e.dataTransfer.effectAllowed = 'move'; 
  };
  
  const handleWardDrop = async (e, targetWardName, sourceWard = draggedWard) => {
    e.preventDefault();
    if (!sourceWard || sourceWard === targetWardName) return;

    const currentOrder = sortedWards;
    const fromIndex = currentOrder.indexOf(sourceWard);
    const toIndex = currentOrder.indexOf(targetWardName);
    
    if (fromIndex === -1 || toIndex === -1) return;

    // 配列操作で順序を変更
    const newOrder = [...currentOrder];
    newOrder.splice(fromIndex, 1);
    newOrder.splice(toIndex, 0, sourceWard);

    // 全病棟の順序をFirestoreに保存
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
  
  // タッチデバイス用DnD処理 (Device)
  const touchItemRef = useRef(null);
  const handleTouchStart = (e, item) => {
    e.stopPropagation();
    touchItemRef.current = item;
  };
  const handleTouchMove = (e) => {};
  const handleTouchEnd = async (e) => {
    e.stopPropagation();
    const changedTouch = e.changedTouches[0];
    const elem = document.elementFromPoint(changedTouch.clientX, changedTouch.clientY);
    const targetRow = elem?.closest('[data-device-id]');
    if (targetRow && touchItemRef.current) {
      const targetId = targetRow.getAttribute('data-device-id');
      if (targetId && targetId !== touchItemRef.current.id) {
        const targetDevice = activeList.find((d) => d.id === targetId);
        if (targetDevice) await handleDrop(e, targetDevice, touchItemRef.current);
      }
    }
    touchItemRef.current = null;
  };

  // タッチデバイス用DnD処理 (Ward)
  const handleWardTouchStart = (e, ward) => {
      touchWardRef.current = ward;
  };
  
  const handleWardTouchEnd = async (e) => {
      const changedTouch = e.changedTouches[0];
      const elem = document.elementFromPoint(changedTouch.clientX, changedTouch.clientY);
      const targetRow = elem?.closest('[data-ward-name]');
      if (targetRow && touchWardRef.current) {
          const targetWardName = targetRow.getAttribute('data-ward-name');
          if (targetWardName && targetWardName !== touchWardRef.current) {
              await handleWardDrop(e, targetWardName, touchWardRef.current);
          }
      }
      touchWardRef.current = null;
  };
  
  // 病棟 > モニタ > 機器 の階層データ生成（単体登録されたモニタも含む）
  const devicesByWardAndMonitor = useMemo(() => {
    const wardGroups = {};
    monitorList.forEach((m) => {
      if (!m.ward || !m.name) return;
      if (filterText && !m.ward.includes(filterText) && !m.name.includes(filterText)) return;
      if (!wardGroups[m.ward]) wardGroups[m.ward] = {};
      if (!wardGroups[m.ward][m.name]) wardGroups[m.ward][m.name] = [];
    });
    displayList.forEach((d) => {
      if (!wardGroups[d.ward]) wardGroups[d.ward] = {};
      if (!wardGroups[d.ward][d.monitorGroup]) wardGroups[d.ward][d.monitorGroup] = [];
      wardGroups[d.ward][d.monitorGroup].push(d);
    });
    return wardGroups;
  }, [displayList, monitorList, filterText]);

  // マスタ順序に基づいた病棟リスト生成
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

  // Step 3 の「既存の他モニタから選択して移動」用のグルーピングリスト
  const movableMonitorGroups = useMemo(() => {
    const groups = {};
    const candidates = activeList.filter(d => {
      // 現在登録・移動先となっている同一病棟・同一モニタの機器は除外
      if (d.ward === newDeviceBase.ward && d.monitorGroup === newDeviceBase.monitorGroup) return false;
      if (moveFilterWard !== 'ALL' && d.ward !== moveFilterWard) return false;
      if (moveSearchText.trim() !== '') {
        const q = moveSearchText.trim();
        if (!d.id.includes(q) && !d.monitorGroup.includes(q) && !d.ward.includes(q)) return false;
      }
      return true;
    });
    candidates.forEach(d => {
      const key = `${d.ward} / ${d.monitorGroup}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(d);
    });
    return groups;
  }, [activeList, newDeviceBase, moveFilterWard, moveSearchText]);

  // 新規追加モードのレンダリング
  if (addMode) {
    const validManualCount = deviceRows.filter(r => r.id.trim() !== '').length;
    const totalTargetChCount = validManualCount + selectedMoveIds.filter(id => !deviceRows.some(r => r.id.trim() === id)).length;
    const canCompleteWithoutCh = addMode === 'MONITOR' || addMode === 'WARD' || monitorMode === 'NEW';

    return (
      <div className="bg-white p-6 rounded-lg shadow-lg border border-gray-200">
        <div className="flex items-center gap-2 mb-4 pb-2 border-b">
          <h3 className="text-xl font-bold">{addMode === 'WARD' ? '新規病棟の開設' : addMode === 'MONITOR' ? '新規モニタの追加' : '送信機の追加・移動'} <span className="text-sm font-normal text-gray-500 ml-2">(Step {addStep}/3)</span></h3>
        </div>
        {addStep === 1 && (
          <div className="space-y-4 animate-fade-in">
            <h4 className="font-bold text-gray-700">{addMode === 'WARD' ? '1. 新しい病棟名を入力してください' : '1. 対象の病棟（または待機場所）を選択してください'}</h4>
            {addMode !== 'WARD' && (
              <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                {allWards.map(ward => {
                  const standby = isStandbyWard(ward);
                  return (
                    <button
                      key={ward}
                      onClick={() => {
                        setNewDeviceBase({...newDeviceBase, ward});
                        setNewMonitorIsLoaner(standby);
                      }}
                      className={`p-3 rounded border text-left flex items-center justify-between gap-1 ${
                        newDeviceBase.ward === ward
                          ? 'bg-blue-100 border-blue-500 text-blue-800 font-bold'
                          : standby
                            ? 'bg-indigo-50/60 border-indigo-200 hover:bg-indigo-50 text-indigo-900'
                            : 'bg-white hover:bg-gray-50'
                      }`}
                    >
                      <span>{ward}</span>
                      {standby && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 border border-indigo-200 whitespace-nowrap">
                          貸出機待機・点検対象外
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {(addMode === 'WARD') && (
              <div className="mt-4"><label className="text-xs text-gray-500 block mb-1">病棟名:</label><input className="w-full border p-2 rounded" placeholder="新しい病棟名（例: ME室、5F北 など）..." value={newDeviceBase.ward} onChange={e => setNewDeviceBase({...newDeviceBase, ward: e.target.value})} autoFocus/></div>
            )}
          </div>
        )}
        {addStep === 2 && (
          <div className="space-y-4 animate-fade-in">
            <h4 className="font-bold text-gray-700">{addMode === 'MONITOR' ? '2. 新しいモニタ情報を入力してください' : '2. モニタ(親機)を選択してください'}</h4>
            <p className="text-sm text-gray-500 mb-2 flex items-center gap-2">
              <span>選択中の病棟: <strong>{newDeviceBase.ward}</strong></span>
              {isStandbyWard(newDeviceBase.ward) && (
                <span className="text-xs font-bold px-2 py-0.5 rounded bg-indigo-100 text-indigo-700 border border-indigo-200">
                  待機中は本日の点検対象外
                </span>
              )}
            </p>
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
                  <div><label className="block text-xs font-bold text-gray-700 mb-1">モニタ型番</label><select className="w-full border p-2 rounded bg-white" value={newMonitorModel} onChange={e => setNewMonitorModel(e.target.value)}><option value="">選択してください</option>{monitorModelsList.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}</select></div>
                  <div><label className="block text-xs font-bold text-gray-700 mb-1">製造番号</label><input className="w-full border p-2 rounded bg-white" placeholder="例: 01677" value={newMonitorSerial} onChange={e => setNewMonitorSerial(e.target.value)}/></div>
                </div>
                <label className="flex items-start gap-2.5 p-2.5 bg-indigo-50/70 border border-indigo-200 rounded-md cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5 rounded text-indigo-600 focus:ring-indigo-500"
                    checked={newMonitorIsLoaner || isStandbyWard(newDeviceBase.ward)}
                    disabled={isStandbyWard(newDeviceBase.ward)}
                    onChange={e => setNewMonitorIsLoaner(e.target.checked)}
                  />
                  <div className="text-xs">
                    <span className="font-bold text-indigo-900">貸出機モニタとして登録する</span>
                    <p className="text-indigo-700 mt-0.5">
                      ME室で待機中は本日の点検対象外になり、病棟へ貸出（移動）した際は「貸出機」バッジとワンタップ返却ボタンが表示されます。
                    </p>
                  </div>
                </label>
                <p className="text-xs text-gray-500">
                  ※chを登録せずモニタ単体で登録する場合は下の「モニタ単体で登録」を押してください。既存の他モニタからchを選んで移動させる場合や新規chを入力する場合は「次へ」進んでください。
                </p>
              </div>
            )}
          </div>
        )}
        {addStep === 3 && (
          <div className="space-y-4 animate-fade-in">
            <h4 className="font-bold text-gray-700">3. 送信機(ch)の設定（他モニタから移動 / 新規入力）</h4>
            <div className="bg-blue-50 p-3 rounded-lg text-sm text-blue-800 border border-blue-100 flex flex-wrap justify-between items-center gap-2">
              <div>
                <span className="font-bold mr-2">登録先:</span>
                <span>{newDeviceBase.ward} / <span className="font-mono font-bold">{newDeviceBase.monitorGroup}</span></span>
              </div>
              {canCompleteWithoutCh && totalTargetChCount === 0 && (
                <span className="text-xs bg-white text-blue-700 px-2 py-0.5 rounded border border-blue-200 font-bold">
                  ch未選択のままモニタ単体登録も可能
                </span>
              )}
            </div>

            {/* 入力方法切替タブ */}
            <div className="flex bg-gray-100 p-1 rounded-lg">
              <button
                type="button"
                onClick={() => setStep3Tab('MOVE_EXISTING')}
                className={`flex-1 py-2 rounded-md text-xs sm:text-sm font-bold transition-all flex items-center justify-center gap-1.5 ${
                  step3Tab === 'MOVE_EXISTING' ? 'bg-white shadow text-blue-600' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <span>既存の他モニタから選択して移動</span>
                {selectedMoveIds.length > 0 && (
                  <span className="bg-blue-600 text-white text-[11px] px-1.5 py-0.2 rounded-full">
                    {selectedMoveIds.length}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setStep3Tab('NEW')}
                className={`flex-1 py-2 rounded-md text-xs sm:text-sm font-bold transition-all flex items-center justify-center gap-1.5 ${
                  step3Tab === 'NEW' ? 'bg-white shadow text-blue-600' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <span>新規chを手入力</span>
                {validManualCount > 0 && (
                  <span className="bg-green-600 text-white text-[11px] px-1.5 py-0.2 rounded-full">
                    {validManualCount}
                  </span>
                )}
              </button>
            </div>

            {step3Tab === 'MOVE_EXISTING' ? (
              <div className="space-y-3">
                <div className="flex flex-col sm:flex-row gap-2">
                  <select
                    className="border p-2 rounded text-sm bg-white sm:w-44"
                    value={moveFilterWard}
                    onChange={e => setMoveFilterWard(e.target.value)}
                  >
                    <option value="ALL">すべての病棟を表示</option>
                    {allWards.map(w => <option key={w} value={w}>{w}</option>)}
                  </select>
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-2.5 text-gray-400" size={16} />
                    <input
                      type="text"
                      placeholder="移動したいch番号やモニタ名で検索..."
                      value={moveSearchText}
                      onChange={e => setMoveSearchText(e.target.value)}
                      className="w-full pl-8 pr-7 py-1.5 border rounded text-sm bg-white"
                    />
                    {moveSearchText && (
                      <button onClick={() => setMoveSearchText('')} className="absolute right-2 top-2 text-gray-400 hover:text-gray-600">
                        <X size={16} />
                      </button>
                    )}
                  </div>
                </div>

                {selectedMoveIds.length > 0 && (
                  <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 flex justify-between items-center text-xs text-green-800">
                    <span className="font-bold">
                      移動対象として {selectedMoveIds.length} 台を選択中（ch: {selectedMoveIds.join(', ')}）
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelectedMoveIds([])}
                      className="text-green-700 hover:underline font-bold ml-2 whitespace-nowrap"
                    >
                      選択解除
                    </button>
                  </div>
                )}

                <div className="max-h-64 overflow-y-auto space-y-3 pr-1">
                  {Object.keys(movableMonitorGroups).length > 0 ? (
                    Object.entries(movableMonitorGroups).map(([groupTitle, groupDevs]) => {
                      const groupIds = groupDevs.map(d => d.id);
                      const allSelected = groupIds.every(id => selectedMoveIds.includes(id));
                      return (
                        <div key={groupTitle} className="border rounded-lg overflow-hidden bg-gray-50">
                          <div className="bg-gray-100 px-3 py-1.5 border-b flex justify-between items-center">
                            <span className="text-xs font-bold text-gray-700 flex items-center gap-1.5">
                              <Monitor size={13} className="text-gray-500" />
                              {groupTitle}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                if (allSelected) {
                                  setSelectedMoveIds(prev => prev.filter(id => !groupIds.includes(id)));
                                } else {
                                  setSelectedMoveIds(prev => Array.from(new Set([...prev, ...groupIds])));
                                }
                              }}
                              className="text-[11px] text-blue-600 hover:underline font-bold"
                            >
                              {allSelected ? 'すべて解除' : 'このモニタのchをすべて選択'}
                            </button>
                          </div>
                          <div className="p-2 grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                            {groupDevs.map(d => {
                              const isSelected = selectedMoveIds.includes(d.id);
                              return (
                                <button
                                  key={d.id}
                                  type="button"
                                  onClick={() => toggleSelectMoveId(d.id)}
                                  className={`p-2 rounded border text-left flex items-center justify-between transition-all ${
                                    isSelected
                                      ? 'bg-blue-600 border-blue-600 text-white font-bold shadow-sm'
                                      : 'bg-white border-gray-200 text-gray-700 hover:border-blue-300 hover:bg-blue-50/40'
                                  }`}
                                >
                                  <div className="min-w-0">
                                    <div className="font-mono text-xs sm:text-sm">ch:{d.id}</div>
                                    <div className={`text-[10px] truncate ${isSelected ? 'text-blue-100' : 'text-gray-400'}`}>{d.model}</div>
                                  </div>
                                  <CheckCircle size={15} className={`flex-shrink-0 ${isSelected ? 'text-white' : 'text-gray-200'}`} />
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="text-center py-8 text-gray-400 text-sm bg-gray-50 rounded border border-dashed">
                      移動可能な他のモニタの送信機が見つかりません
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-12 gap-2 text-xs font-bold text-gray-500 px-1"><div className="col-span-6">ch (管理番号)</div><div className="col-span-5">型番</div><div className="col-span-1"></div></div>
                {deviceRows.map((row, index) => {
                  const trimmed = row.id.trim();
                  const isDupInForm = trimmed !== '' && deviceRows.some((r, idx) => idx !== index && r.id.trim() === trimmed);
                  const existingMatch = trimmed !== '' ? list.find(d => d.id === trimmed) : null;

                  return (
                    <div key={index} className="space-y-1">
                      <div className="grid grid-cols-12 gap-2 items-center">
                        <div className="col-span-6">
                          <input
                            className={`w-full border p-2 rounded font-mono ${
                              isDupInForm
                                ? 'border-red-500 bg-red-50'
                                : existingMatch
                                  ? 'border-amber-500 bg-amber-50'
                                  : ''
                            }`}
                            placeholder="例: 1001"
                            value={row.id}
                            onChange={e => updateRow(index, 'id', e.target.value)}
                            autoFocus={index === deviceRows.length - 1}
                          />
                        </div>
                        <div className="col-span-5">
                          <select className="w-full border p-2 rounded" value={row.model} onChange={e => updateRow(index, 'model', e.target.value)}>
                            {transmitterModelsList.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                          </select>
                        </div>
                        <div className="col-span-1 flex justify-center">
                          {deviceRows.length > 1 && (
                            <button onClick={() => removeRow(index)} className="text-red-400 hover:text-red-600 p-1">
                              <Trash2 size={18}/>
                            </button>
                          )}
                        </div>
                      </div>
                      {isDupInForm && (
                        <div className="text-xs text-red-600 font-bold flex items-center gap-1 pl-1">
                          <AlertTriangle size={13} /> この入力画面内で同じ ch:{trimmed} が重複しています
                        </div>
                      )}
                      {!isDupInForm && existingMatch && (
                        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 flex items-center gap-1">
                          <AlertTriangle size={13} className="flex-shrink-0 text-amber-600" />
                          <span>
                            {existingMatch.isDeleted
                              ? `ch:${trimmed} は削除済み機器（旧: ${existingMatch.ward} / ${existingMatch.monitorGroup}）に存在します（登録時に復元・上書き確認を行います）`
                              : `ch:${trimmed} はすでに「${existingMatch.ward} / ${existingMatch.monitorGroup}」に存在します（登録時に移動・上書き確認を行います）`}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
                <button onClick={addRow} className="w-full py-2 border-2 border-dashed border-gray-300 rounded-lg text-gray-500 hover:border-blue-400 hover:text-blue-500 hover:bg-blue-50 transition-colors flex items-center justify-center gap-2"><Plus size={16}/> 機器を追加</button>
              </div>
            )}
          </div>
        )}
        <div className="flex justify-between items-center mt-8 pt-4 border-t gap-2">
           {addStep > 1 ? <button onClick={() => setAddStep(s => s - 1)} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded flex items-center gap-1"><ArrowLeft size={16}/> 戻る</button> : <button onClick={() => setAddMode(null)} className="px-4 py-2 text-gray-500 hover:bg-gray-100 rounded">キャンセル</button>}
           <div className="flex items-center gap-2">
             {addStep === 2 && monitorMode === 'NEW' && (
               <button
                 onClick={handleCompleteMonitorOnly}
                 className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 flex items-center gap-1 text-sm font-bold"
               >
                 <Save size={16}/> モニタ単体で登録
               </button>
             )}
             {addStep < 3 ? (
               <button onClick={handleNextStep} className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center gap-1 font-bold">
                 次へ <ArrowRight size={16}/>
               </button>
             ) : (
               <button onClick={handleCompleteAdd} className="px-6 py-2 bg-green-600 text-white rounded hover:bg-green-700 flex items-center gap-1 font-bold">
                 <Save size={16}/>
                 {totalTargetChCount === 0 && canCompleteWithoutCh
                   ? 'モニタ単体で登録完了'
                   : `登録完了${totalTargetChCount > 0 ? ` (${totalTargetChCount}台)` : ''}`}
               </button>
             )}
           </div>
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

      {/* 機器情報編集・移動モーダル */}
      {editItem && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/20 backdrop-blur-[1px] p-4">
          <div className="bg-white p-6 rounded-lg shadow-xl w-full max-w-md border space-y-4">
            <h3 className="font-bold text-lg flex items-center gap-2">
              <Edit2 size={18} className="text-blue-600"/>
              {editItem.isDeleted ? '削除済み送信機の復元・移動先選択' : '送信機の編集・移動'}
            </h3>
            <div className="space-y-3">
               <div>
                 <label className="text-xs font-bold text-gray-600 block mb-1">ch (管理番号)</label>
                 <input
                   className={`w-full border p-2 rounded font-mono ${
                     editItem.id.trim() !== '' && editItem.id.trim() !== originalId && list.some(d => d.id === editItem.id.trim())
                       ? 'border-amber-500 bg-amber-50'
                       : 'bg-white'
                   }`}
                   value={editItem.id}
                   onChange={e => setEditItem({...editItem, id: e.target.value})}
                 />
                 {(() => {
                   const trimmedEditId = editItem.id.trim();
                   if (!trimmedEditId || trimmedEditId === originalId) return null;
                   const conflict = list.find(d => d.id === trimmedEditId);
                   if (!conflict) return null;
                   return (
                     <div className="mt-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 flex items-center gap-1">
                       <AlertTriangle size={13} className="flex-shrink-0 text-amber-600" />
                       <span>
                         {conflict.isDeleted
                           ? `ch:${trimmedEditId} は削除済み機器（旧: ${conflict.ward} / ${conflict.monitorGroup}）に存在します`
                           : `ch:${trimmedEditId} はすでに「${conflict.ward} / ${conflict.monitorGroup}」に存在します`}
                       </span>
                     </div>
                   );
                 })()}
               </div>
               
               <div>
                 <div className="flex justify-between items-center mb-1">
                   <label className="text-xs font-bold text-gray-600">所属病棟 (移動先)</label>
                   <button
                     type="button"
                     onClick={() => {
                       const nextMode = editWardMode === 'EXISTING' ? 'NEW' : 'EXISTING';
                       setEditWardMode(nextMode);
                       if (nextMode === 'EXISTING' && allWards.length > 0) {
                         handleEditWardChange(allWards[0]);
                       } else if (nextMode === 'NEW') {
                         setEditMonitorMode('NEW');
                         setEditItem(prev => ({ ...prev, ward: '', monitorGroup: '' }));
                       }
                     }}
                     className="text-xs text-blue-600 hover:underline"
                   >
                     {editWardMode === 'EXISTING' ? '+ 新規病棟へ移動' : '既存病棟から選択'}
                   </button>
                 </div>
                 {editWardMode === 'EXISTING' ? (
                   <select
                     className="w-full border p-2 rounded bg-white"
                     value={editItem.ward}
                     onChange={e => handleEditWardChange(e.target.value)}
                   >
                     {allWards.map(w => <option key={w} value={w}>{w}</option>)}
                   </select>
                 ) : (
                   <input
                     className="w-full border p-2 rounded bg-white"
                     placeholder="新しい病棟名を入力..."
                     value={editItem.ward}
                     onChange={e => setEditItem({ ...editItem, ward: e.target.value })}
                   />
                 )}
               </div>

               <div>
                 <div className="flex justify-between items-center mb-1">
                   <label className="text-xs font-bold text-gray-600">モニタ (移動先親機)</label>
                   {editWardMode === 'EXISTING' && getMonitorsByWard(editItem.ward).length > 0 && (
                     <button
                       type="button"
                       onClick={() => setEditMonitorMode(prev => prev === 'EXISTING' ? 'NEW' : 'EXISTING')}
                       className="text-xs text-blue-600 hover:underline"
                     >
                       {editMonitorMode === 'EXISTING' ? '+ 新規モニタを作成' : '既存モニタから選択'}
                     </button>
                   )}
                 </div>
                 {editMonitorMode === 'EXISTING' && getMonitorsByWard(editItem.ward).length > 0 ? (
                   <select
                     className="w-full border p-2 rounded bg-white"
                     value={editItem.monitorGroup}
                     onChange={e => setEditItem({ ...editItem, monitorGroup: e.target.value })}
                   >
                     {getMonitorsByWard(editItem.ward).map(m => <option key={m} value={m}>{m}</option>)}
                   </select>
                 ) : (
                   <div className="grid grid-cols-2 gap-2 bg-gray-50 p-2.5 rounded border">
                     <div>
                       <label className="block text-[11px] text-gray-500 mb-1">モニタ型番</label>
                       <select
                         className="w-full border p-1.5 rounded bg-white text-sm"
                         value={editNewMonitorModel}
                         onChange={e => setEditNewMonitorModel(e.target.value)}
                       >
                         <option value="">選択</option>
                         {monitorModelsList.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                       </select>
                     </div>
                     <div>
                       <label className="block text-[11px] text-gray-500 mb-1">製造番号</label>
                       <input
                         className="w-full border p-1.5 rounded bg-white text-sm"
                         placeholder="例: 01677"
                         value={editNewMonitorSerial}
                         onChange={e => setEditNewMonitorSerial(e.target.value)}
                       />
                     </div>
                   </div>
                 )}
               </div>

               <div>
                 <label className="text-xs font-bold text-gray-600 block mb-1">送信機型番</label>
                 <select className="w-full border p-2 rounded bg-white" value={editItem.model} onChange={e => setEditItem({...editItem, model: e.target.value})}>
                   {transmitterModelsList.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                 </select>
               </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t">
               <button onClick={() => setEditItem(null)} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded">キャンセル</button>
               <button onClick={handleUpdate} className="px-4 py-2 bg-blue-600 text-white rounded font-bold hover:bg-blue-700">
                 {editItem.isDeleted ? 'この内容で復元する' : '更新・移動する'}
               </button>
            </div>
          </div>
        </div>
      )}

      {/* モニタ情報編集・病棟移動（貸出／返却）モーダル */}
      {editingMonitor && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/20 backdrop-blur-[1px] p-4">
          <div className="bg-white p-6 rounded-lg shadow-xl w-full max-w-md border space-y-4">
            <h3 className="font-bold text-lg flex items-center gap-2">
              <Edit2 size={20} className={editingMonitor.loanOutMode ? 'text-indigo-600' : 'text-green-600'}/>
              {editingMonitor.loanOutMode ? '貸出機モニタを病棟へ貸出（移動）' : 'モニタ情報の編集・病棟移動'}
            </h3>
            
            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="block text-xs font-bold text-gray-700">
                  {editingMonitor.loanOutMode ? '貸出先の病棟' : '所属病棟 (モニタごと移動)'}
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const nextMode = editingMonitor.wardMode === 'NEW' ? 'EXISTING' : 'NEW';
                    setEditingMonitor(prev => ({
                      ...prev,
                      wardMode: nextMode,
                      ward: nextMode === 'EXISTING' ? prev.oldWard : ''
                    }));
                  }}
                  className="text-xs text-blue-600 hover:underline"
                >
                  {editingMonitor.wardMode === 'NEW' ? '既存病棟から選択' : '+ 新規病棟へ移動'}
                </button>
              </div>
              {editingMonitor.wardMode === 'NEW' ? (
                <input
                  className="w-full border p-2 rounded bg-white"
                  placeholder="移動先の新しい病棟名..."
                  value={editingMonitor.ward}
                  onChange={e => setEditingMonitor({ ...editingMonitor, ward: e.target.value })}
                />
              ) : (
                <select
                  className="w-full border p-2 rounded bg-white"
                  value={editingMonitor.ward}
                  onChange={e => setEditingMonitor({ ...editingMonitor, ward: e.target.value })}
                >
                  {allWards.map(w => (
                    <option key={w} value={w}>
                      {w}{isStandbyWard(w) ? '（待機・点検対象外）' : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div><label className="block text-xs font-bold text-gray-700 mb-1">モニタ型番</label><select className="w-full border p-2 rounded bg-white" value={editingMonitor.model} onChange={e => setEditingMonitor({...editingMonitor, model: e.target.value})}>{monitorModelsList.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}</select></div>
              <div><label className="block text-xs font-bold text-gray-700 mb-1">製造番号</label><input className="w-full border p-2 rounded bg-white" value={editingMonitor.serial} onChange={e => setEditingMonitor({...editingMonitor, serial: e.target.value})}/></div>
            </div>

            <label className="flex items-start gap-2.5 p-2.5 bg-indigo-50/70 border border-indigo-200 rounded-md cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 rounded text-indigo-600 focus:ring-indigo-500"
                checked={Boolean(editingMonitor.isLoaner || isStandbyWard(editingMonitor.ward))}
                disabled={isStandbyWard(editingMonitor.ward)}
                onChange={e => setEditingMonitor({ ...editingMonitor, isLoaner: e.target.checked })}
              />
              <div className="text-xs">
                <span className="font-bold text-indigo-900">貸出機モニタとして扱う</span>
                <p className="text-indigo-700 mt-0.5">
                  病棟へ貸出中も「貸出機」バッジが表示され、ワンタップでME室へ返却できます。
                </p>
              </div>
            </label>

            <div className="mt-2 text-center bg-gray-50 p-3 rounded border">
              <div className="text-xs text-gray-400 mb-1">更新後の所属・モニタ名</div>
              <div className="font-mono text-sm font-bold text-gray-800">{editingMonitor.ward || '(未入力)'} / {editingMonitor.model} ({editingMonitor.serial})</div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t">
               <button onClick={() => setEditingMonitor(null)} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded">キャンセル</button>
               <button onClick={handleUpdateMonitorName} className="px-4 py-2 bg-blue-600 text-white rounded font-bold hover:bg-blue-700">
                 {editingMonitor.loanOutMode ? 'この病棟へ貸出する' : '一括更新'}
               </button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {/* 病棟ごとのリスト (並び替え対応) */}
        {sortedWards.map((ward) => {
          const monitorGroups = devicesByWardAndMonitor[ward];
          const standbyWard = isStandbyWard(ward);
          return (
            <div 
              key={ward} 
              className={`border rounded-lg bg-white overflow-hidden shadow-sm transition-all ${standbyWard ? 'border-indigo-200' : ''}`}
              draggable="true"
              onDragStart={(e) => handleWardDragStart(e, ward)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleWardDrop(e, ward)}
              onTouchStart={(e) => handleWardTouchStart(e, ward)} 
              onTouchMove={handleTouchMove} 
              onTouchEnd={handleWardTouchEnd}
              data-ward-name={ward}
            >
              <div 
                className={`w-full p-3 flex justify-between items-center transition-colors cursor-move ${
                  standbyWard ? 'bg-indigo-50/70 hover:bg-indigo-100/70' : 'bg-gray-50 hover:bg-gray-100'
                }`}
                onClick={() => toggleWard(ward)}
              >
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 pointer-events-none">
                        <Menu size={16} className="text-gray-400"/>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                        <MapPin size={18} className={standbyWard ? 'text-indigo-600' : 'text-blue-500'}/>
                        <span className="font-bold text-gray-800">{ward}</span>
                        {standbyWard && (
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200">
                            貸出機待機場所（本日の点検対象外）
                          </span>
                        )}
                    </div>
                </div>
                
                <div className="text-gray-400">
                    {expandedWards[ward] ? <ChevronUp size={20}/> : <ChevronDown size={20}/>}
                </div>
              </div>
              
              {expandedWards[ward] && (
                <div className="p-3 bg-white space-y-4 animate-slide-up">
                  {Object.entries(monitorGroups).map(([monitorName, monitorDevices]) => {
                    const loanerMonitor = isMonitorLoaner(ward, monitorName);
                    return (
                      <div key={monitorName} className={`border rounded-md overflow-hidden ${loanerMonitor ? 'border-indigo-200' : ''}`}>
                        <div className={`px-3 py-2 flex flex-wrap items-center justify-between gap-2 ${loanerMonitor ? 'bg-indigo-50/60' : 'bg-gray-100'}`}>
                          <div className="flex items-center gap-2 text-sm font-bold text-gray-700 flex-wrap">
                            <Monitor size={14} className={loanerMonitor ? 'text-indigo-600' : 'text-green-600'}/>
                            <span>{monitorName}</span>
                            {loanerMonitor && (
                              <span className="text-[11px] font-bold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 border border-indigo-200">
                                {standbyWard ? '貸出機（待機中）' : '貸出機'}
                              </span>
                            )}
                            <span className="text-xs font-normal text-gray-500 bg-white px-1.5 py-0.5 rounded border">
                              {monitorDevices.length}台
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {standbyWard && (
                              <button
                                onClick={() => {
                                  const match = monitorName.match(/^(.+)\s\((.+)\)$/);
                                  const firstRegularWard = allWards.find(w => !isStandbyWard(w)) || ward;
                                  setEditingMonitor({
                                    oldWard: ward,
                                    ward: firstRegularWard,
                                    wardMode: 'EXISTING',
                                    oldName: monitorName,
                                    model: match ? match[1] : monitorName,
                                    serial: match ? match[2] : '',
                                    isLoaner: true,
                                    oldIsLoaner: loanerMonitor,
                                    loanOutMode: true
                                  });
                                }}
                                className="text-xs flex items-center gap-1 bg-indigo-600 text-white px-2.5 py-1 rounded hover:bg-indigo-700 font-bold transition-colors shadow-sm"
                                title="貸出先の病棟を選択して移動"
                              >
                                <ArrowRight size={12}/> 病棟へ貸出
                              </button>
                            )}
                            {!standbyWard && loanerMonitor && (
                              <button
                                onClick={() => handleReturnMonitorToME(ward, monitorName)}
                                className="text-xs flex items-center gap-1 bg-indigo-50 border border-indigo-300 text-indigo-700 px-2.5 py-1 rounded hover:bg-indigo-100 font-bold transition-colors"
                                title="ME室（待機場所）へワンタップで返却"
                              >
                                <ArrowLeft size={12}/> ME室へ返却
                              </button>
                            )}
                            <button
                              onClick={() => {
                                const defaultModel = transmitterModelsList.length > 0 ? transmitterModelsList[0].name : '';
                                setNewDeviceBase({ ward, monitorGroup: monitorName });
                                setDeviceRows([{ id: '', model: defaultModel }]);
                                setMonitorMode('EXISTING');
                                setSelectedMoveIds([]);
                                setMoveFilterWard('ALL');
                                setMoveSearchText('');
                                setStep3Tab('MOVE_EXISTING');
                                setAddMode('DEVICE');
                                setAddStep(3);
                              }}
                              className="text-xs flex items-center gap-1 bg-white border border-green-300 px-2 py-1 rounded hover:bg-green-50 text-green-700 font-bold transition-colors"
                              title="他モニタからchを移動または新規追加"
                            >
                              <Plus size={12}/> ch移動・追加
                            </button>
                            <button
                              onClick={() => {
                                const match = monitorName.match(/^(.+)\s\((.+)\)$/);
                                setEditingMonitor({
                                  oldWard: ward,
                                  ward: ward,
                                  wardMode: 'EXISTING',
                                  oldName: monitorName,
                                  model: match ? match[1] : monitorName,
                                  serial: match ? match[2] : '',
                                  isLoaner: loanerMonitor,
                                  oldIsLoaner: loanerMonitor,
                                  loanOutMode: false
                                });
                              }}
                              className="text-xs flex items-center gap-1 bg-white border px-2 py-1 rounded hover:bg-blue-50 text-blue-600 transition-colors"
                            >
                              <Edit2 size={12}/> 編集・移動
                            </button>
                            {monitorDevices.length === 0 && (
                              <button
                                onClick={() => handleDeleteEmptyMonitor(ward, monitorName)}
                                className="text-xs flex items-center gap-1 bg-white border border-red-200 px-2 py-1 rounded hover:bg-red-50 text-red-600 transition-colors"
                                title="空のモニタを削除"
                              >
                                <Trash2 size={12}/>
                              </button>
                            )}
                          </div>
                        </div>
                      <div className="divide-y divide-gray-100 relative">
                        {monitorDevices.length > 0 ? monitorDevices.map(d => (
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
                              <button onClick={() => handleStartEdit(d)} className="p-1.5 text-blue-500 hover:bg-blue-50 rounded transition-colors" title="編集・移動"><Edit2 size={16}/></button>
                              <button onClick={() => onDelete(d.id)} className="p-1.5 text-red-500 hover:bg-red-50 rounded transition-colors" title="削除"><Trash2 size={16}/></button>
                            </div>
                          </div>
                        )) : (
                          <div className="p-4 text-center text-xs text-gray-400 bg-gray-50/40">
                            送信機が登録されていません（上の「＋ch移動・追加」から既存のchを選択して移動できます）
                          </div>
                        )}
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 削除済み機器（アーカイブ）一覧 */}
      {deletedList.length > 0 && (
        <div className="mt-6 border border-gray-300 rounded-lg bg-gray-100 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowDeletedDevices(prev => !prev)}
            className="w-full p-3 flex justify-between items-center text-sm font-bold text-gray-600 hover:bg-gray-200 transition-colors"
          >
            <span className="flex items-center gap-2"><Trash2 size={16} className="text-gray-500"/> 削除済み機器 ({deletedList.length}台)</span>
            {showDeletedDevices ? <ChevronUp size={18}/> : <ChevronDown size={18}/>}
          </button>
          {showDeletedDevices && (
            <div className="p-3 bg-white divide-y divide-gray-100">
              {deletedList.map(d => (
                <div key={d.id} className="py-2.5 px-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold font-mono text-gray-700">ch:{d.id}</span>
                      <span className="text-xs text-gray-400">({d.model})</span>
                      {d.deletedAt && <span className="text-[11px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded border">削除日: {d.deletedAt}</span>}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">元所属: {d.ward} / {d.monitorGroup}</div>
                  </div>
                  <div className="flex items-center gap-2 self-end sm:self-center">
                    <button
                      onClick={() => handleStartEdit(d)}
                      className="text-xs bg-white text-blue-600 border border-blue-200 px-2.5 py-1 rounded hover:bg-blue-50 font-bold transition-colors"
                      title="別の病棟・モニタを選択して復元"
                    >
                      移動して復元
                    </button>
                    <button
                      onClick={() => onRestore(d.id)}
                      className="text-xs bg-blue-50 text-blue-600 border border-blue-200 px-2.5 py-1 rounded hover:bg-blue-100 font-bold transition-colors"
                      title="元の所属へ復元"
                    >
                      元所属へ復元
                    </button>
                    <button
                      onClick={() => onPermanentDelete(d.id)}
                      className="text-xs bg-red-50 text-red-600 border border-red-200 px-2.5 py-1 rounded hover:bg-red-100 transition-colors"
                    >
                      完全削除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// StaffMasterEditor: スタッフ編集画面 (DnD対応)
function StaffMasterEditor({ list, onSave, onDelete }) {
  const [formData, setFormData] = useState({ id: '', name: '' });
  const [editItem, setEditItem] = useState(null);
  const [draggedItem, setDraggedItem] = useState(null);
  const touchItemRef = useRef(null);

  useEffect(() => {
    if (editItem) setFormData(editItem);
    else setFormData({ id: crypto.randomUUID(), name: '' });
  }, [editItem]);

  // 新規追加・更新時の処理
  const handleSaveWrapper = () => {
    if (!formData.name) return;
    
    const itemToSave = { ...formData };
    
    // 新規追加の場合、sortOrderを末尾に設定
    if (!itemToSave.sortOrder && !editItem) {
        const maxSort = list.length > 0 ? Math.max(...list.map(s => s.sortOrder || 0)) : 0;
        itemToSave.sortOrder = maxSort + 1;
    }
    
    onSave(itemToSave);
    setFormData({ id: crypto.randomUUID(), name: '' });
    setEditItem(null);
  };

  // DnD Handlers
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

  // 修正後: リスト全体の順序を再計算して保存する方式に変更
  const handleDrop = async (e, targetItem, sourceItem = draggedItem) => {
    e.preventDefault();
    if (!sourceItem || sourceItem.id === targetItem.id) return;

    // 現在の表示順（ソート済み）リストを取得
    const currentList = [...list].sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999));
    
    const fromIndex = currentList.findIndex(item => item.id === sourceItem.id);
    const toIndex = currentList.findIndex(item => item.id === targetItem.id);
    
    if (fromIndex === -1 || toIndex === -1) return;

    // 配列内でアイテムを移動
    const newList = [...currentList];
    const [movedItem] = newList.splice(fromIndex, 1);
    newList.splice(toIndex, 0, movedItem);

    // 新しい順序で連番を振り直して保存
    const batch = writeBatch(db);
    newList.forEach((item, index) => {
        // sortOrder は 1 から開始
        const newOrder = index + 1;
        // 値が変わる場合のみ更新予約（書き込み削減）
        if (item.sortOrder !== newOrder) {
            batch.update(doc(db, 'artifacts', appId, 'public', 'data', 'staff', item.id), { sortOrder: newOrder });
        }
    });
    
    await batch.commit();
    setDraggedItem(null);
  };

  // Touch Handlers for Mobile
  const handleTouchStart = (e, item) => { touchItemRef.current = item; };
  const handleTouchMove = (e) => {}; // Prevent default scrolling if necessary, but careful
  const handleTouchEnd = async (e) => {
    const changedTouch = e.changedTouches[0];
    const elem = document.elementFromPoint(changedTouch.clientX, changedTouch.clientY);
    const targetRow = elem?.closest('[data-staff-id]');
    if (targetRow && touchItemRef.current) {
      const targetId = targetRow.getAttribute('data-staff-id');
      if (targetId && targetId !== touchItemRef.current.id) {
        const targetStaff = list.find((s) => s.id === targetId);
        if (targetStaff) await handleDrop(e, targetStaff, touchItemRef.current);
      }
    }
    touchItemRef.current = null;
  };

  return (
    <div className="space-y-4">
      <div className="bg-white p-4 rounded shadow space-y-3">
        <h3 className="font-bold text-gray-700">{editItem ? 'スタッフ編集' : '新規追加'}</h3>
        <div className="flex gap-2">
          <input className="border p-2 rounded flex-1" placeholder="氏名" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} />
          {editItem && <button onClick={() => setEditItem(null)} className="px-3 py-1 bg-gray-300 rounded">キャンセル</button>}
          <button disabled={!formData.name} onClick={handleSaveWrapper} className="px-3 py-1 bg-blue-600 text-white rounded flex items-center gap-1"><Save size={16}/> 保存</button>
        </div>
      </div>
      <div className="space-y-2">
        {list.map(s => (
          <div 
            key={s.id} 
            data-staff-id={s.id}
            className="bg-white p-3 rounded shadow flex justify-between items-center cursor-move active:bg-blue-50 active:opacity-80"
            draggable="true"
            onDragStart={(e) => handleDragStart(e, s)}
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, s)}
            onTouchStart={(e) => handleTouchStart(e, s)} 
            onTouchMove={handleTouchMove} 
            onTouchEnd={handleTouchEnd}
          >
            <div className="flex items-center gap-3 pointer-events-none">
                <Menu size={16} className="text-gray-400"/>
                <span className="font-bold">{s.name}</span>
            </div>
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

// TransmitterModelEditor: 型番編集画面 (DnD対応)
function TransmitterModelEditor({ list, onSave, onDelete }) {
  const [formData, setFormData] = useState({ id: '', name: '', type: 'TRANSMITTER' });
  const [editItem, setEditItem] = useState(null);
  const [draggedItem, setDraggedItem] = useState(null);
  const touchItemRef = useRef(null);

  useEffect(() => {
    if (editItem) setFormData(editItem);
    else setFormData({ id: '', name: '', type: 'TRANSMITTER' });
  }, [editItem]);

  // 新規追加・更新処理 (sortOrder付与・スラッシュ等の記号対応・既存機器への型番名反映)
  const handleSubmit = async () => {
    const trimmedName = formData.name.trim();
    if (!trimmedName) return;

    // 新規追加時はスラッシュ等を含んでも安全なIDを生成、編集時は既存IDを維持
    const safeId = editItem ? editItem.id : encodeURIComponent(trimmedName);
    const itemToSave = { ...formData, name: trimmedName, id: safeId };
    
    // 新規追加時のsortOrder自動採番
    if (!itemToSave.sortOrder && !editItem) {
        const maxSort = list.length > 0 ? Math.max(...list.map(m => m.sortOrder || 0)) : 0;
        itemToSave.sortOrder = maxSort + 1;
    }

    await onSave(itemToSave, editItem);
    setFormData({ id: '', name: '', type: 'TRANSMITTER' });
    setEditItem(null);
  };

  // DnD Handlers
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

  const handleDrop = async (e, targetItem, sourceItem = draggedItem) => {
      e.preventDefault();
      if (!sourceItem || sourceItem.id === targetItem.id) return;
      
      const currentList = [...list].sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999));
      const fromIndex = currentList.findIndex(item => item.id === sourceItem.id);
      const toIndex = currentList.findIndex(item => item.id === targetItem.id);

      if (fromIndex === -1 || toIndex === -1) return;

      const newList = [...currentList];
      const [movedItem] = newList.splice(fromIndex, 1);
      newList.splice(toIndex, 0, movedItem);

      const batch = writeBatch(db);
      newList.forEach((item, index) => {
          const newOrder = index + 1;
          if (item.sortOrder !== newOrder) {
              batch.update(doc(db, 'artifacts', appId, 'public', 'data', 'transmitter_models', item.id), { sortOrder: newOrder });
          }
      });
      
      await batch.commit();
      setDraggedItem(null);
  };

  // Touch Handlers for Mobile
  const handleTouchStart = (e, item) => { touchItemRef.current = item; };
  const handleTouchMove = (e) => {};
  const handleTouchEnd = async (e) => {
    const changedTouch = e.changedTouches[0];
    const elem = document.elementFromPoint(changedTouch.clientX, changedTouch.clientY);
    const targetRow = elem?.closest('[data-model-id]');
    if (targetRow && touchItemRef.current) {
      const targetId = targetRow.getAttribute('data-model-id');
      if (targetId && targetId !== touchItemRef.current.id) {
        const targetModel = list.find((m) => m.id === targetId);
        if (targetModel) await handleDrop(e, targetModel, touchItemRef.current);
      }
    }
    touchItemRef.current = null;
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
          <div 
            key={m.id} 
            data-model-id={m.id}
            className="bg-white p-3 rounded shadow flex justify-between items-center cursor-move active:bg-blue-50 active:opacity-80"
            draggable="true"
            onDragStart={(e) => handleDragStart(e, m)}
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, m)}
            onTouchStart={(e) => handleTouchStart(e, m)} 
            onTouchMove={handleTouchMove} 
            onTouchEnd={handleTouchEnd}
          >
            <div className="flex items-center gap-3 pointer-events-none">
                <Menu size={16} className="text-gray-400"/>
                <div><span className={`text-xs px-2 py-0.5 rounded mr-2 ${m.type === 'TRANSMITTER' ? 'bg-orange-100 text-orange-800' : 'bg-green-100 text-green-800'}`}>{m.type === 'TRANSMITTER' ? '送信機' : 'モニタ'}</span><span className="font-bold">{m.name}</span></div>
            </div>
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

// --------------------------------------------------------------------------------------
// HistoryModal: 履歴ダッシュボード
// --------------------------------------------------------------------------------------
function HistoryModal({ db, appId, devices, wardList, onClose, onDownloadCSV }) {
  const [historyRecords, setHistoryRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterMode, setFilterMode] = useState('ALL');
  const [searchTerm, setSearchTerm] = useState(''); // 検索キーワード
  const [showExportModal, setShowExportModal] = useState(false); // CSV出力モーダル
  
  const [expandedDates, setExpandedDates] = useState({});
  const [expandedWards, setExpandedWards] = useState({});

  useEffect(() => {
    const fetchHistory = async () => {
      // 履歴データの取得
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

  // 表示用にフィルタリングされたレコード
  const filteredRecords = useMemo(() => {
    return historyRecords.filter(r => {
      // 不具合フィルタ
      if (filterMode === 'ISSUES') {
         if (!(r.reception === 'BAD' || r.isBroken === 'YES' || r.channelCheck === 'NG')) return false;
      }
      
      // テキスト検索
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

  // マスタ情報を使ってソート順を決定するヘルパー
  const getDeviceSortOrder = (deviceId) => {
    const d = devices.find(dev => dev.id === deviceId);
    return d ? (d.sortOrder ?? 9999) : 9999;
  };
  
  const getWardSortOrder = (wardName) => {
    const w = wardList.find(w => w.name === wardName);
    return w ? (w.sortOrder ?? 9999) : (isStandbyWard(wardName) ? 99999 : 9999);
  };

  // 履歴のグルーピングとソート (日付 > 病棟 > モニタ > 機器)
  const groupedHistory = useMemo(() => {
    const groups = {};
    
    // まず日付でまとめる
    filteredRecords.forEach(r => {
      if (!groups[r.date]) groups[r.date] = [];
      groups[r.date].push(r);
    });

    // 日付ごとにマスタ順（病棟順 > モニタ名順 > 機器sortOrder順 > ch順）でソート
    Object.keys(groups).forEach(date => {
      groups[date].sort((a, b) => {
         // 1. 病棟順
         const wa = getWardSortOrder(a.ward);
         const wb = getWardSortOrder(b.ward);
         if (wa !== wb) return wa - wb;
         if ((a.ward || '') !== (b.ward || '')) return (a.ward || '').localeCompare(b.ward || '');

         // 2. モニタ名順（同一病棟内でモニタが混ざらないようまとめる）
         if ((a.monitorGroup || '') !== (b.monitorGroup || '')) {
           return (a.monitorGroup || '').localeCompare(b.monitorGroup || '');
         }
         
         // 3. 機器順 (sortOrder)
         const da = getDeviceSortOrder(a.deviceId);
         const db = getDeviceSortOrder(b.deviceId);
         if (da !== db) return da - db; 

         // 4. sortOrderが同じならID順
         return a.deviceId.localeCompare(b.deviceId);
      });
    });

    return groups;
  }, [filteredRecords, devices, wardList]);

  // 表示用に階層化されたデータを生成 (病棟 > モニタ)
  const displayStructure = useMemo(() => {
      const result = {};
      Object.entries(groupedHistory).forEach(([date, records]) => {
          // 1. 病棟ごとにグループ化しつつ、出現順（マスタ順）を維持
          const wardsOrder = [];
          const wardMap = {};

          records.forEach(r => {
              if (!wardMap[r.ward]) {
                  wardMap[r.ward] = { name: r.ward, monitors: [] };
                  wardsOrder.push(r.ward);
              }
              
              // モニタグループの検索または追加
              let monitorGroup = wardMap[r.ward].monitors.find(m => m.name === r.monitorGroup);
              if (!monitorGroup) {
                  monitorGroup = { name: r.monitorGroup, records: [] };
                  wardMap[r.ward].monitors.push(monitorGroup);
              }
              monitorGroup.records.push(r);
          });

          result[date] = wardsOrder.map(wardName => {
              const wardData = wardMap[wardName];
              return {
                  wardName: wardName,
                  monitors: wardData.monitors.map(m => ({
                      monitorName: m.name,
                      records: m.records
                  }))
              };
          });
      });
      return result;
  }, [groupedHistory]);

  // 最新の日付を初期展開
  useEffect(() => {
    if (Object.keys(displayStructure).length > 0) {
        const sortedDates = Object.keys(displayStructure).sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
        if (sortedDates.length > 0) {
            setExpandedDates(prev => ({ ...prev, [sortedDates[0]]: true }));
        }
    }
  }, [displayStructure]); 

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

  // 月報CSV出力処理
  const handleExportMonthly = (monthStr) => {
      if (!monthStr) return;
      
      const targetRecords = historyRecords.filter(r => r.date.startsWith(monthStr));
      const currentMonthStr = getTodayString().slice(0, 7);
      
      const year = parseInt(monthStr.split('-')[0], 10);
      const month = parseInt(monthStr.split('-')[1], 10);
      const lastDay = new Date(year, month, 0).getDate();
      const days = Array.from({length: lastDay}, (_, i) => i + 1);
      
      const header = ['病棟', 'モニタ', 'ch', '型番', ...days.map(d => `${d}日`)];

      const formatDayCells = (entryRecords) => {
          const recordsByDay = {};
          entryRecords.forEach(r => {
              const d = parseInt(r.date.split('-')[2], 10);
              recordsByDay[d] = r;
          });
          return days.map(d => {
              const r = recordsByDay[d];
              if (!r) return '';
              if (r.isBroken === 'YES' || r.channelCheck === 'NG') return '×';
              if (r.reception === 'BAD' || (r.note && r.note.trim() !== '')) return '△';
              if (r.inUse === 'YES') return '○';
              if (r.inUse === 'NO') return '-';
              return '';
          });
      };

      const sortEntries = (entries) => {
          return [...entries].sort((a, b) => {
              const wa = getWardSortOrder(a.ward);
              const wb = getWardSortOrder(b.ward);
              if (wa !== wb) return wa - wb;
              if (a.ward !== b.ward) return (a.ward || '').localeCompare(b.ward || '');
              if (a.monitorGroup !== b.monitorGroup) return (a.monitorGroup || '').localeCompare(b.monitorGroup || '');
              if ((a.sortOrder ?? 9999) !== (b.sortOrder ?? 9999)) return (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999);
              return a.deviceId.localeCompare(b.deviceId);
          });
      };

      // 1. 対象月時点で稼働中の機器（Active Devices in target month）の行生成
      // ※月途中の移動は移動前・移動後の病棟/モニタ別に行を分割
      // ※翌月以降に論理削除された機器でも、削除月より前の過去月報では通常機器として出力する
      const activeInMonthDevices = devices.filter(d => !isDeviceDeletedInMonth(d, monthStr));
      const activeEntries = [];

      activeInMonthDevices.forEach(device => {
          const devRecords = targetRecords.filter(r => r.deviceId === device.id);
          const locationMap = new Map();

          devRecords.forEach(r => {
              const w = r.ward || device.ward;
              const m = r.monitorGroup || device.monitorGroup;
              const key = `${w}___${m}`;
              if (!locationMap.has(key)) {
                  locationMap.set(key, {
                      ward: w,
                      monitorGroup: m,
                      deviceId: device.id,
                      model: r.model || device.model,
                      sortOrder: device.sortOrder ?? 9999,
                      records: []
                  });
              }
              locationMap.get(key).records.push(r);
          });

          // 現在の所属病棟・モニタでの空行追加判定:
          // - 現在も未削除 (!device.isDeleted)
          // - 待機場所(ME室)ではない (!isStandbyWard(device.ward))
          // - 当月(または未来月)の月報である (monthStr >= currentMonthStr) ※過去月の月報に現在所属の空行が混ざるのを防止
          // - 当月まだどの病棟でも1件も点検記録がない (locationMap.size === 0) ※移動直後で移動先未点検のときに空行が二重に出るのを防止
          const currentKey = `${device.ward}___${device.monitorGroup}`;
          if (
              !device.isDeleted &&
              !locationMap.has(currentKey) &&
              !isStandbyWard(device.ward) &&
              locationMap.size === 0 &&
              monthStr >= currentMonthStr
          ) {
              locationMap.set(currentKey, {
                  ward: device.ward,
                  monitorGroup: device.monitorGroup,
                  deviceId: device.id,
                  model: device.model,
                  sortOrder: device.sortOrder ?? 9999,
                  records: []
              });
          }

          locationMap.forEach(entry => activeEntries.push(entry));
      });

      // 2. 削除済み機器（Deleted Devices）の行生成（月報の最下部にまとめて出力）
      // ※対象月に1回以上点検記録が存在する削除済み機器のみを出力（点検実績0件の空行は出力しない）
      const deletedEntries = [];
      const deletedInMonthDevices = devices.filter(d => isDeviceDeletedInMonth(d, monthStr));

      deletedInMonthDevices.forEach(device => {
          const devRecords = targetRecords.filter(r => r.deviceId === device.id);
          if (devRecords.length > 0) {
              const locationMap = new Map();
              devRecords.forEach(r => {
                  const w = r.ward || device.ward;
                  const m = r.monitorGroup || device.monitorGroup;
                  const key = `${w}___${m}`;
                  if (!locationMap.has(key)) {
                      locationMap.set(key, {
                          ward: w,
                          monitorGroup: m,
                          deviceId: device.id,
                          model: r.model || device.model,
                          sortOrder: device.sortOrder ?? 9999,
                          records: []
                      });
                  }
                  locationMap.get(key).records.push(r);
              });
              locationMap.forEach(entry => deletedEntries.push(entry));
          }
      });

      // 過去に完全削除されマスタに存在しないが、対象月の点検記録が残っている機器も抽出
      const unknownDeviceMap = new Map();
      targetRecords.forEach(r => {
          if (!devices.some(d => d.id === r.deviceId)) {
              const w = r.ward || '';
              const m = r.monitorGroup || '';
              const key = `${w}___${m}___${r.deviceId}`;
              if (!unknownDeviceMap.has(key)) {
                  unknownDeviceMap.set(key, {
                      ward: w,
                      monitorGroup: m,
                      deviceId: r.deviceId,
                      model: r.model || '',
                      sortOrder: 9999,
                      records: []
                  });
              }
              unknownDeviceMap.get(key).records.push(r);
          }
      });
      unknownDeviceMap.forEach(entry => deletedEntries.push(entry));

      const activeRows = sortEntries(activeEntries).map(entry => [
          entry.ward,
          entry.monitorGroup,
          entry.deviceId,
          entry.model,
          ...formatDayCells(entry.records)
      ].map(escapeCSVCell).join(','));

      const deletedRows = sortEntries(deletedEntries).map(entry => [
          entry.ward,
          entry.monitorGroup,
          entry.deviceId,
          entry.model,
          ...formatDayCells(entry.records)
      ].map(escapeCSVCell).join(','));

      const rows = [...activeRows];
      if (deletedRows.length > 0) {
          rows.push(['【削除済み機器】', '', '', '', ...days.map(() => '')].map(escapeCSVCell).join(','));
          rows.push(...deletedRows);
      }

      // BOMを付与してBlobを作成する方式
      const csvString = [header.map(escapeCSVCell).join(','), ...rows].join('\n');
      const bom = new Uint8Array([0xEF, 0xBB, 0xBF]); // BOM (Byte Order Mark)
      const blob = new Blob([bom, csvString], { type: "text/csv;charset=utf-8" });

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.setAttribute("href", url);
      link.setAttribute("download", `送信機点検月報_${monthStr}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
  };

  const sortedDateKeys = Object.keys(displayStructure).sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white w-full max-w-4xl h-[90vh] rounded-xl shadow-2xl overflow-hidden flex flex-col">
        <div className="bg-gray-800 text-white p-4 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-bold flex items-center gap-2"><BarChart2 size={20}/> 履歴・分析ダッシュボード</h2>
            <button onClick={() => setShowExportModal(true)} className="flex items-center gap-1 bg-white/10 hover:bg-white/20 text-white px-3 py-1.5 rounded transition-colors text-xs font-bold border border-white/20">
                <Download size={14}/> CSV出力
            </button>
          </div>
          <button onClick={onClose}><X size={20}/></button>
        </div>
        <div className="p-4 border-b bg-gray-50 flex flex-col gap-4">
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
                // 担当者の抽出
                const checkers = Array.from(new Set(
                    wardsData.flatMap(w => w.monitors.flatMap(m => m.records.map(r => r.checker)))
                )).filter(Boolean).join(', ');

                // 日ごとの統計計算（待機場所・ME室での誤入力分があれば稼働率計算の母数から除外）
                const dailyRawRecords = historyRecords.filter(r => r.date === date);
                const dailyTargetRecords = dailyRawRecords.filter(r => !isStandbyWard(r.ward));
                const statsBase = dailyTargetRecords.length > 0 ? dailyTargetRecords : dailyRawRecords;
                const dailyTotal = statsBase.length;
                const dailyInUse = statsBase.filter(r => r.inUse === 'YES').length;
                const dailyIssues = dailyRawRecords.filter(r => r.reception === 'BAD' || r.isBroken === 'YES' || r.channelCheck === 'NG').length;
                const dailyUtilization = dailyTotal > 0 ? Math.round((dailyInUse / dailyTotal) * 100) : 0;

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
                    
                    {/* 日ごとの統計情報 */}
                    <div className="flex items-center gap-4">
                        {dailyTotal > 0 && (
                            <div className="flex gap-2">
                                <div className="bg-blue-50 px-3 py-1 rounded border border-blue-200 flex flex-col items-center leading-none min-w-[60px]">
                                    <span className="text-[10px] text-gray-500 mb-0.5">稼働率</span>
                                    <span className="font-bold text-sm text-blue-700">{dailyUtilization}%</span>
                                </div>
                                <div className="bg-red-50 px-3 py-1 rounded border border-red-200 flex flex-col items-center leading-none min-w-[60px]">
                                    <span className="text-[10px] text-gray-500 mb-0.5">不具合</span>
                                    <span className="font-bold text-sm text-red-700">{dailyIssues}件</span>
                                </div>
                            </div>
                        )}
                        {expandedDates[date] ? <ChevronUp size={20} className="text-gray-400"/> : <ChevronDown size={20} className="text-gray-400"/>}
                    </div>
                  </div>
                  
                  {expandedDates[date] && (
                    <div className="animate-slide-up">
                      {wardsData.map(wardData => {
                        const wardKey = `${date}_${wardData.wardName}`;
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
                                                      const deviceMaster = devices.find(d => d.id === r.deviceId);
                                                      const isDeletedOnThatDay = isDeviceDeletedOnDate(deviceMaster, r.date);
                                                      const isDeletedLater = !isDeletedOnThatDay && (!deviceMaster || !!deviceMaster.isDeleted);
    
                                                      return (
                                                        <div key={i} className={`p-3 text-sm flex flex-col gap-2 hover:bg-gray-50 ${isIssue ? 'bg-red-50/50' : ''}`}>
                                                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                                                            <div className="flex items-center gap-3 flex-wrap">
                                                                <span className="text-gray-400 text-xs font-mono">{r.timestamp.split(' ')[1]}</span>
                                                                <span className="font-bold w-16 text-lg">{r.deviceId}</span>
                                                                <span className="text-xs text-gray-500">{r.model}</span>
                                                                {isDeletedOnThatDay && (
                                                                    <span className="text-[10px] bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded font-bold border border-gray-300">削除済</span>
                                                                )}
                                                                {isDeletedLater && (
                                                                    <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded border border-gray-300">現在: 削除済 ({deviceMaster?.deletedAt})</span>
                                                                )}
                                                            </div>
                                                            <div className="flex items-center gap-4">
                                                                {r.inUse === 'YES' ? <span className="text-blue-600 text-xs bg-blue-50 px-2 py-0.5 rounded border border-blue-100">使用中</span> : <span className="text-gray-400 text-xs">未使用</span>}
                                                                {r.reception === 'BAD' && <span className="flex items-center gap-1 text-red-600 font-bold text-xs bg-red-100 px-2 py-0.5 rounded"><AlertTriangle size={12}/> 受信不良 ({receptionText})</span>}
                                                                {r.isBroken === 'YES' && <span className="flex items-center gap-1 text-red-600 font-bold text-xs bg-red-100 px-2 py-0.5 rounded"><AlertOctagon size={12}/> 破損あり</span>}
                                                                {r.channelCheck === 'NG' && <span className="flex items-center gap-1 text-red-600 font-bold text-xs bg-red-100 px-2 py-0.5 rounded"><AlertTriangle size={12}/> ch不一致</span>}
                                                                {!isIssue && r.inUse === 'YES' && <span className="text-green-600 text-xs flex items-center gap-1"><CheckCircle size={12}/> 良好</span>}
                                                            </div>
                                                          </div>
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
      {/* CSV Export Modal */}
      {showExportModal && (
          <CSVExportModal 
            onClose={() => setShowExportModal(false)}
            onExportDaily={(date) => {
                const targets = historyRecords.filter(r => r.date === date);
                if(targets.length === 0) return alert('該当日のデータがありません');
                
                // 日報出力時もマスタ順（病棟順 > モニタ名順 > 機器sortOrder順 > ch順）にソートする
                targets.sort((a, b) => {
                     const wa = getWardSortOrder(a.ward);
                     const wb = getWardSortOrder(b.ward);
                     if (wa !== wb) return wa - wb;
                     if ((a.ward || '') !== (b.ward || '')) return (a.ward || '').localeCompare(b.ward || '');
                     if ((a.monitorGroup || '') !== (b.monitorGroup || '')) return (a.monitorGroup || '').localeCompare(b.monitorGroup || '');
                     
                     const da = getDeviceSortOrder(a.deviceId);
                     const db = getDeviceSortOrder(b.deviceId);
                     if (da !== db) return da - db; 

                     return a.deviceId.localeCompare(b.deviceId);
                });

                onDownloadCSV(targets, date);
                setShowExportModal(false);
            }}
            onExportMonthly={(month) => {
                handleExportMonthly(month);
                setShowExportModal(false);
            }}
          />
      )}
    </div>
  );
}

// 7. CSVExportModal (CSV出力設定モーダル)
function CSVExportModal({ onClose, onExportDaily, onExportMonthly }) {
    const [mode, setMode] = useState('DAILY'); // DAILY | MONTHLY
    const [date, setDate] = useState(new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-'));
    const [month, setMonth] = useState(new Date().toISOString().slice(0, 7)); // YYYY-MM

    return (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-fade-in">
            <div className="bg-white w-full max-w-sm rounded-xl shadow-2xl p-6 animate-scale-in">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-bold flex items-center gap-2"><Download size={20}/> CSV出力設定</h3>
                    <button onClick={onClose}><X size={20} className="text-gray-400 hover:text-gray-600"/></button>
                </div>
                
                <div className="flex bg-gray-100 p-1 rounded-lg mb-6">
                    <button onClick={() => setMode('DAILY')} className={`flex-1 py-2 rounded-md text-sm font-bold transition-all ${mode === 'DAILY' ? 'bg-white shadow text-blue-600' : 'text-gray-500'}`}>日報 (1日分)</button>
                    <button onClick={() => setMode('MONTHLY')} className={`flex-1 py-2 rounded-md text-sm font-bold transition-all ${mode === 'MONTHLY' ? 'bg-white shadow text-blue-600' : 'text-gray-500'}`}>月報 (1ヶ月分)</button>
                </div>

                <div className="space-y-4 mb-6">
                    {mode === 'DAILY' ? (
                        <div>
                            <label className="block text-sm font-bold text-gray-700 mb-1">日付を選択</label>
                            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full border p-2 rounded-lg" />
                        </div>
                    ) : (
                        <div>
                            <label className="block text-sm font-bold text-gray-700 mb-1">月を選択</label>
                            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-full border p-2 rounded-lg" />
                        </div>
                    )}
                </div>

                <button 
                    onClick={() => mode === 'DAILY' ? onExportDaily(date) : onExportMonthly(month)}
                    className="w-full py-3 bg-blue-600 text-white rounded-lg font-bold shadow-md hover:bg-blue-700 active:scale-95 transition-all flex justify-center items-center gap-2"
                >
                    <Download size={18}/> 出力する
                </button>
            </div>
        </div>
    );
}

// 6. DeviceHistoryModal (個別機器の履歴モーダル)
function DeviceHistoryModal({ db, appId, device, onClose }) {
    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchDeviceHistory = async () => {
            const q = query(
                collection(db, 'artifacts', appId, 'public', 'data', 'checks'),
                where('deviceId', '==', device.id)
            );
            
            try {
                const snapshot = await getDocs(q);
                const list = snapshot.docs.map(d => d.data());
                // メモリ上で日付降順にソート
                list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
                setRecords(list.slice(0, 30)); // 最新30件のみ表示
            } catch (e) {
                console.error("Error fetching device history:", e);
            } finally {
                setLoading(false);
            }
        };
        fetchDeviceHistory();
    }, [db, appId, device]);

    const receptionReasonMap = { A: '電波切れ', B: '電極確認', C: '一時退床中', D: 'その他' };

    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-fade-in">
            <div className="bg-white w-full max-w-md h-[80vh] rounded-xl shadow-2xl overflow-hidden flex flex-col">
                <div className="bg-gray-800 text-white p-4 flex justify-between items-center shrink-0">
                    <div>
                        <div className="text-xs text-gray-300 flex items-center gap-1"><MapPin size={10}/> {device.ward} / {device.monitorGroup}</div>
                        <h2 className="text-lg font-bold flex items-center gap-2">ch: {device.id} <span className="text-sm font-normal opacity-70">履歴</span></h2>
                    </div>
                    <button onClick={onClose} className="p-1 hover:bg-gray-700 rounded-full"><X size={20}/></button>
                </div>
                
                <div className="flex-1 overflow-y-auto p-4 bg-gray-50">
                    {loading ? (
                        <div className="text-center py-10 text-gray-500">読み込み中...</div>
                    ) : records.length === 0 ? (
                        <div className="text-center py-10 text-gray-400">過去の点検記録はありません</div>
                    ) : (
                        <div className="space-y-3">
                            {records.map((r, i) => {
                                const isIssue = r.reception === 'BAD' || r.isBroken === 'YES' || r.channelCheck === 'NG';
                                const receptionText = r.receptionReason ? `${r.receptionReason}: ${receptionReasonMap[r.receptionReason] || ''}` : '';
                                const recordWard = r.ward || device.ward;
                                const recordMonitor = r.monitorGroup || device.monitorGroup;
                                const isDifferentLocation = recordWard !== device.ward || recordMonitor !== device.monitorGroup;
                                
                                return (
                                    <div key={i} className={`bg-white p-3 rounded-lg border shadow-sm ${isIssue ? 'border-red-200 bg-red-50/50' : 'border-gray-100'}`}>
                                        <div className="flex justify-between items-start mb-1.5">
                                            <div className="flex items-center gap-2">
                                                <span className="font-bold text-gray-700 flex items-center gap-1"><Calendar size={14}/> {r.date}</span>
                                                <span className="text-xs text-gray-400 font-mono">{r.timestamp.split(' ')[1]}</span>
                                            </div>
                                            <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded">{r.checker}</span>
                                        </div>

                                        <div className={`text-xs px-2 py-1 rounded mb-2 flex items-center gap-1.5 ${isDifferentLocation ? 'bg-amber-50 text-amber-800 border border-amber-200 font-bold' : 'bg-gray-50 text-gray-500'}`}>
                                            <MapPin size={12} className="shrink-0"/>
                                            <span>{recordWard} / {recordMonitor}</span>
                                            {isDifferentLocation && <span className="ml-auto text-[10px] bg-amber-200/70 text-amber-900 px-1.5 py-0.2 rounded">移動前</span>}
                                        </div>
                                        
                                        <div className="space-y-1 text-sm">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs text-gray-400 w-16">使用状況</span>
                                                <span className={r.inUse === 'YES' ? 'text-blue-600 font-bold' : 'text-gray-400'}>
                                                    {r.inUse === 'YES' ? '使用中' : '未使用'}
                                                </span>
                                            </div>
                                            
                                            {r.inUse === 'YES' && (
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs text-gray-400 w-16">受信状態</span>
                                                    {r.reception === 'BAD' ? (
                                                        <span className="text-red-600 font-bold flex items-center gap-1"><AlertTriangle size={12}/> 不良 ({receptionText})</span>
                                                    ) : (
                                                        <span className="text-green-600 font-bold flex items-center gap-1"><CheckCircle size={12}/> 良好</span>
                                                    )}
                                                </div>
                                            )}
                                            
                                            {r.inUse === 'NO' && (
                                                <>
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-xs text-gray-400 w-16">破損</span>
                                                        {r.isBroken === 'YES' ? <span className="text-red-600 font-bold">あり</span> : <span className="text-green-600">なし</span>}
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-xs text-gray-400 w-16">ch確認</span>
                                                        {r.channelCheck === 'NG' ? <span className="text-red-600 font-bold">NG (不一致)</span> : <span className="text-green-600">OK</span>}
                                                    </div>
                                                </>
                                            )}

                                            {r.receptionNote && <div className="text-xs text-gray-600 bg-gray-50 p-2 rounded mt-1">理由詳細: {r.receptionNote}</div>}
                                            {r.note && <div className="text-xs text-gray-600 bg-yellow-50 p-2 rounded mt-1 border border-yellow-100">備考: {r.note}</div>}
                                        </div>
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