// js/store/index.js
const { ref, reactive, computed } = Vue;

export const user = ref(null);
export const stocks = ref([]);
export const exchangeRate = ref(32.5);
export const lastUpdated = ref('-');
export const loadingTarget = ref(null);
export const isLoading = computed(() => loadingTarget.value !== null);
export const viewMode = ref('auto');
export const isMobile = ref(window.innerWidth < 768);
export const showPrivacy = ref(false);
export const defaultPrivacyHidden = ref(false);
export const hideZeroShares = ref(localStorage.getItem('hideZeroShares') === 'true');
export const showSettingsModal = ref(false);
export const isDarkMode = ref(localStorage.getItem('darkMode') === 'true');
export const activeSection = ref('');
export const showChangelog = ref(false);
export const stockStates = ref({});
export const sectionLoading = ref(false);



export const showStockNoteModal = ref(false);
export const stockNoteForm = ref({ id: '', symbol: '', name: '', content: '' });

export const showHistoryModal = ref(false);
export const historyRecords = ref([]);
export const historyFilterYear = ref(new Date().getFullYear());
export const availableYears = ref([]);

export const showDeleteModal = ref(false);
export const pendingDeleteTx = ref(null);
export const showEditTxModal = ref(false);
export const editTxForm = ref({ id: null, date: '', name: '', memo: '' });
export const showHistoryEditModalVisible = ref(false);
export const historyEditForm = ref({ date: '', twVal: 0, usVal: 0, twCash: 0, usCash: 0, loan: 0, realestate: 0 });
export const notes = ref([]);
export const showNoteModalVisible = ref(false);
export const noteForm = ref({ id: null, title: '', date: '', content: '' });
export const loanList = ref([]);
export const showLoanMgrModal = ref(false);
export const inlineNewLoan = ref(false);
export const inlineLoanName = ref('');
export const loanForm = ref({ id: null, name: '', balance: 0, type: 'other', isInvestmentUse: false, monthlyPayment: 0, note: '' });
export const cashData = ref({ twd: 0, usd: 0, loan: 0 });
export const prevDayData = ref(null);

export const realEstateList = ref([]);
export const showRealEstateModal = ref(false);
export const realEstateForm = ref({ id: null, name: '', address: '', purchaseDate: '', purchaseCost: 0, marketValue: 0, mortgageLoanIds: [], note: '' });

export const chartStartDate = ref(''); 
export const chartEndDate = ref('');
export const chartPnl = ref({ amount: null, pct: null, startVal: null, endVal: null });
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
