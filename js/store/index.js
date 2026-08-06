// js/store/index.js
const { ref, reactive, computed } = Vue;

export const user = ref(null);
export const stocks = ref([]);
// v5.9.0: 匯率優先用「上次成功取得的值」，避免線上 API 掛掉時整包美股用寫死的 32.5 計價。
// exchangeRateConfirmed=false 代表現在用的是保底預設值，這種狀態不可寫入每日快照（會永久污染歷史走勢）。
const _savedRate = parseFloat(localStorage.getItem('lastExchangeRate'));
export const exchangeRate = ref(_savedRate > 0 ? _savedRate : 32.5);
export const exchangeRateConfirmed = ref(_savedRate > 0);
export const lastUpdated = ref('-');
export const loadingTarget = ref(null);
export const isLoading = computed(() => loadingTarget.value !== null);
export const viewMode = ref('auto');
export const isMobile = ref(window.innerWidth < 768);
export const showPrivacy = ref(false);
export const defaultPrivacyHidden = ref(false);
export const hideZeroShares = ref(localStorage.getItem('hideZeroShares') === 'true');
export const showSettingsModal = ref(false);
// v5.15.0: 非阻斷式提示。原本一律用 alert()，在 PWA 全螢幕模式下特別突兀，
// 而且更新股價後還要手動點掉。破壞性操作的 confirm() 維持不變，那本來就該擋住使用者。
export const toasts = ref([]);
// 表單的行內驗證訊息，格式為 { 欄位名稱: '錯誤訊息' }
export const formErrors = ref({});
// v5.10.0: 自動備份提醒。Drive 備份需要 OAuth 彈窗（瀏覽器要求使用者手勢），
// 靜態網頁無法完全靜默地備份，所以做成「到期自動提醒 + 一鍵備份」。
export const autoBackupEnabled = ref(localStorage.getItem('autoBackupEnabled') === 'true');
export const autoBackupIntervalDays = ref(Number(localStorage.getItem('autoBackupIntervalDays')) || 7);
export const lastBackupAt = ref(localStorage.getItem('lastBackupAt') || '');
export const showBackupReminder = ref(false);
// v5.18.0: 槓桿儀表板的計算說明預設收起（只會看一兩次，攤開會把數字擠到很下面）
export const showLeverageNotes = ref(false);
export const isDarkMode = ref(localStorage.getItem('darkMode') === 'true');
export const activeSection = ref('overview');
export const showChangelog = ref(false);
export const stockStates = ref({});
export const sectionLoading = ref(false);



export const showStockNoteModal = ref(false);
export const stockNoteForm = ref({ id: '', symbol: '', name: '', content: '' });

export const showHistoryModal = ref(false);
export const historyRecords = ref([]);
export const historyFilterYear = ref(new Date().getFullYear());
export const availableYears = ref([]);
// v5.22.0: 歷史紀錄累積後清單很長（一年約 250 筆），加上月份篩選與「只看手動校正過的」
export const historyFilterMonth = ref(0);      // 0 = 全年
export const historyOnlyEdited = ref(false);

export const showDeleteModal = ref(false);
export const pendingDeleteTx = ref(null);
export const showEditTxModal = ref(false);
export const editTxForm = ref({ id: null, date: '', name: '', memo: '' });
export const showHistoryEditModalVisible = ref(false);
export const historyEditForm = ref({ date: '', twVal: 0, usVal: 0, twCash: 0, usCash: 0, loan: 0, realestate: 0, futures: 0, funds: 0 });
// v5.20.0: 批次修正歷史紀錄。早期的房地產／房貸處理方式與現在不同，逐日手改太累。
export const showBulkHistoryModal = ref(false);
export const bulkHistoryForm = ref({ start: '', end: '', fields: { realestate: false, loan: false, futures: false, funds: false }, values: { realestate: 0, loan: 0, futures: 0, funds: 0 } });
export const bulkHistoryBusy = ref(false);
export const notes = ref([]);
export const showNoteModalVisible = ref(false);
export const noteForm = ref({ id: null, title: '', date: '', content: '' });
export const loanList = ref([]);
export const showLoanMgrModal = ref(false);
export const inlineNewLoan = ref(false);
export const inlineLoanName = ref('');
export const loanForm = ref({ id: null, name: '', balance: 0, type: 'other', isInvestmentUse: false, monthlyPayment: 0, interestRate: 0, note: '', status: 'active' });
export const cashData = ref({ twd: 0, usd: 0, loan: 0 });
export const prevDayData = ref(null);

export const realEstateList = ref([]);
export const showRealEstateModal = ref(false);
export const realEstateForm = ref({ id: null, name: '', address: '', purchaseDate: '', purchaseCost: 0, marketValue: 0, mortgageLoanIds: [], note: '' });

export const chartStartDate = ref(''); 
export const chartEndDate = ref('');
export const chartPnl = ref({ amount: null, pct: null, startVal: null, endVal: null, netFlow: 0 });
export const currentRange = ref('1M');
export const divRange = ref('YTD');
export const divSearchQuery = ref('');
export const divStartDate = ref(''); 
export const divEndDate = ref('');
export const realizedStartDate = ref(''); 
export const realizedEndDate = ref('');
export const transStartDate = ref(''); 
export const transEndDate = ref('');
export const transFilterType = ref('all'); 
export const transSearchQuery = ref('');
export const sortKeyTrans = ref('date'); 
export const sortOrderTrans = ref('desc');
export const sortKeyDiv = ref('date'); 
export const sortOrderDiv = ref('desc');

export const realizedGains = ref([]);
export const realizedSearchQuery = ref('');
export const sortKeyRealized = ref('date');
export const sortOrderRealized = ref('desc');
export const realizedRange = ref('YTD');


export const dividendRecords = ref([]);
export const transactionHistory = ref([]);

export const showModal = ref(false); 
export const isEditing = ref(false);
export const form = ref({ id: null, symbol: '', name: '', currency: 'TWD', shares: 0, avgCost: 0, totalCostInput: 0, currentPrice: 0, dividends: 0, previousClose: 0, multiplier: 1 });
export const showTransModal = ref(false); 
export const isFundMode = ref(false); 
export const isLoanMode = ref(false); 
export const loanCashMode = ref('sync');
export const transForm = ref({ id: null, type: 'buy', symbol: '', name: '', shares: '', totalAmount: '', currentShares: 0, currentAvg: 0, date: '', loanId: '', memo: '' });


export const monthlyProfitData = ref([]);
export const monthlyProfitRange = ref(6);

// --- 期貨相關狀態 ---
export const futuresMargin = ref({ twd: 0, usd: 0 });
export const futuresPositions = ref([]);
export const showFuturesModal = ref(false);
export const futuresForm = ref({ id: null, symbol: '', expiry: '', direction: 'long', contracts: '', entryPrice: '', currentPrice: '', multiplier: '', marginUsed: '', currency: 'TWD', note: '' });
export const showFuturesMarginModal = ref(false);
export const futuresMarginForm = ref({ amount: '', currency: 'TWD', type: 'deposit', syncCash: true, loanId: '', note: '' });
export const showFuturesActionModal = ref(false);
export const futuresActionForm = ref({ mode: 'close', pos: null, closePrice: '', fee: '', newExpiry: '', newOpenPrice: '' });
export const futuresLoading = ref(false);
export const futuresTransactions = ref([]);
// v5.23.0: 期貨歷史明細的時間篩選。累積久了一次列出全部會很長，預設只看近一個月。
export const futuresHistoryRange = ref('1M');   // 1M / 3M / YTD / ALL / custom
export const futuresHistoryStart = ref('');
export const futuresHistoryEnd = ref('');
// 手續費事後補填：下單當下看不到費用，要等對帳單才知道，所以做成表格內可直接改。
export const editingFuturesFeeId = ref(null);
export const editingFuturesFeeValue = ref('');
// v5.24.0: 事後修正成交價。展期／平倉當下自動帶入的是「最後成交價」而非本人成交價，
// 對完帳單才發現填錯時，需要能改價並讓損益、已實現、保證金一起重算。
export const showFuturesTxEditModal = ref(false);
export const futuresTxEditForm = ref({
    id: null, type: '', symbol: '', direction: 'long', contracts: 0, multiplier: 0,
    entryPrice: 0, currency: 'TWD', date: '', closePrice: '', openPrice: '', fee: '',
    spreadInput: '', realizedGainsId: null, newPositionId: null,
    origNet: 0, farPositionOpen: false
});

// --- 子分頁切換狀態 ---
export const investmentsTab = ref('stocks');
export const performanceTab = ref('realized');
export const overviewTab = ref('trend');

// --- 基金相關狀態 ---
export const mutualFundList = ref([]);
export const showMutualFundModal = ref(false);
export const mutualFundForm = ref({ id: null, name: '', currency: 'TWD', costBasis: '', currentValue: '', purchaseDate: '', note: '' });
