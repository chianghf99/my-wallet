import { db, auth } from './firebase-config.js';
import { getLocalDate, formatNumber, formatCurrency, getPnlClass, getRoi, formatChange, getTypeName, getAmountSign, getFuturesDisplayName } from './utils/format.js';

import { 
    user, stocks, exchangeRate, lastUpdated, loadingTarget, isLoading, viewMode, isMobile, showPrivacy, defaultPrivacyHidden, hideZeroShares, showSettingsModal, isDarkMode, activeSection, showChangelog, stockStates, sectionLoading, showStockNoteModal, stockNoteForm, showHistoryModal, historyRecords, historyFilterYear, availableYears, showDeleteModal, pendingDeleteTx, showEditTxModal, editTxForm, showHistoryEditModalVisible, historyEditForm, notes, showNoteModalVisible, noteForm, loanList, showLoanMgrModal, inlineNewLoan, inlineLoanName, loanForm, cashData, prevDayData, realEstateList, showRealEstateModal, realEstateForm, chartStartDate, chartEndDate, chartPnl, currentRange, divRange, divSearchQuery, divStartDate, divEndDate, realizedStartDate, realizedEndDate, transStartDate, transEndDate, transFilterType, transSearchQuery, sortKeyTrans, sortOrderTrans, sortKeyDiv, sortOrderDiv, realizedGains, realizedSearchQuery, sortKeyRealized, sortOrderRealized, realizedRange, dividendRecords, transactionHistory, showModal, isEditing, form, showTransModal, isFundMode, isLoanMode, loanCashMode, transForm,
    monthlyProfitData, monthlyProfitRange,
    futuresMargin, futuresPositions, showFuturesModal, futuresForm, showFuturesMarginModal, futuresMarginForm, futuresLoading, futuresTransactions,
    investmentsTab, performanceTab, overviewTab,
    mutualFundList, showMutualFundModal, mutualFundForm
} from './store/index.js';
const { createApp, ref, computed, onMounted, watch } = Vue;

        createApp({
            setup() {
                // --- 1. 變數定義區 ---
                const futuresHistoryTab = ref('pnl');
                let unsubscribeRealEstate = null, unsubscribeFuturesPositions = null, unsubscribeFuturesMargin = null, unsubscribeFuturesTransactions = null;
                let _initialChartTimer = null;
                let _initialStocksReady = false, _initialCashReady = false;
                const _scheduleInitialChart = () => {
                    if (!_initialStocksReady || !_initialCashReady) return;
                    clearTimeout(_initialChartTimer);
                    _initialChartTimer = setTimeout(() => {
                        saveDailySnapshot().then(() => {
                            if (activeSection.value === 'overview') {
                                if (overviewTab.value === 'trend') drawChart();
                                else if (overviewTab.value === 'pie') drawPieCharts();
                            }
                        });
                        _initialStocksReady = false; _initialCashReady = false;
                    }, 600);
                };
                const fileInput = ref(null);
                let chartInstance = null, pieTwInstance = null, pieUsInstance = null, monthlyProfitChartInstance = null;
                let unsubscribe = null, unsubscribeTrans = null, unsubscribeCash = null, unsubscribeNotes = null, unsubscribeLoans = null;
                
                const drawMonthlyChart = async () => {
                    if (!user.value || !document.getElementById('monthlyProfitChart')) return;
                    sectionLoading.value = true;
                    try {
                        const monthsToFetch = monthlyProfitRange.value;
                        const today = new Date();
                        const labels = [];
                        const dataRealized = [];
                        const dataDividend = [];
                        const dataUnrealized = [];
                        const tableData = [];

                        const monthBoundaries = [];
                        for (let i = 0; i <= monthsToFetch; i++) {
                            const d = new Date(today.getFullYear(), today.getMonth() - i + 1, 0); 
                            monthBoundaries.push(d.toISOString().split('T')[0]);
                        }
                        const earliestDate = monthBoundaries[monthBoundaries.length - 1];

                        const historySnap = await db.collection('users').doc(user.value.uid).collection('history')
                            .where('date', '>=', earliestDate)
                            .orderBy('date', 'asc').get();
                        const historyMap = {};
                        historySnap.docs.forEach(doc => { historyMap[doc.id] = doc.data(); });

                        const realizedSnap = await db.collection('users').doc(user.value.uid).collection('realized_gains')
                            .where('date', '>=', earliestDate).get();
                        const dividendSnap = await db.collection('users').doc(user.value.uid).collection('dividends')
                            .where('date', '>=', earliestDate).get();

                        const realizedList = realizedSnap.docs.map(d => d.data());
                        const dividendList = dividendSnap.docs.map(d => d.data());

                        for (let i = 0; i < monthsToFetch; i++) {
                            const endOfMonth = monthBoundaries[i];
                            const startOfMonth = monthBoundaries[i+1];
                            const monthLabel = endOfMonth.substring(0, 7);

                            const getHistoryForDate = (date) => {
                                if (historyMap[date]) return historyMap[date];
                                const dates = Object.keys(historyMap).filter(d => d <= date).sort();
                                return dates.length ? historyMap[dates[dates.length-1]] : null;
                            };

                            const endHist = getHistoryForDate(endOfMonth);
                            const startHist = getHistoryForDate(startOfMonth);

                            const realized = realizedList.filter(r => r.date > startOfMonth && r.date <= endOfMonth)
                                .reduce((acc, r) => acc + (r.currency === 'USD' ? r.pnl * exchangeRate.value : r.pnl), 0);
                            
                            const dividend = dividendList.filter(d => d.date > startOfMonth && d.date <= endOfMonth)
                                .reduce((acc, d) => acc + (d.currency === 'USD' ? d.amount * exchangeRate.value : d.amount), 0);

                            let unrealized = 0;
                            if (endHist && startHist) {
                                unrealized = (endHist.totalPnL || 0) - (startHist.totalPnL || 0) + realized;
                            }

                            labels.unshift(monthLabel);
                            dataRealized.unshift(realized);
                            dataDividend.unshift(dividend);
                            dataUnrealized.unshift(unrealized);
                            tableData.push({
                                month: monthLabel,
                                dividend,
                                realized,
                                unrealized,
                                total: dividend + realized + unrealized
                            });
                        }

                        monthlyProfitData.value = tableData;

                        if (monthlyProfitChartInstance) monthlyProfitChartInstance.destroy();
                        const isDark = document.documentElement.classList.contains('dark');
                        const gridColor = isDark ? '#374151' : '#e5e7eb';
                        
                        monthlyProfitChartInstance = new Chart(document.getElementById('monthlyProfitChart').getContext('2d'), {
                            type: 'bar',
                            data: {
                                labels: labels,
                                datasets: [
                                    { label: '股息', data: dataDividend, backgroundColor: '#f97316', stack: 'Stack 0' },
                                    { label: '已實現', data: dataRealized, backgroundColor: '#3b82f6', stack: 'Stack 0' },
                                    { label: '未實現變動', data: dataUnrealized, backgroundColor: '#a78bfa', stack: 'Stack 0' }
                                ]
                            },
                            options: {
                                responsive: true, maintainAspectRatio: false,
                                scales: {
                                    x: { stacked: true, grid: { display: false }, ticks: { color: isDark ? '#9ca3af' : '#666' } },
                                    y: { stacked: true, grid: { color: gridColor }, ticks: { color: isDark ? '#9ca3af' : '#666', callback: v => formatNumber(v) } }
                                },
                                plugins: {
                                    legend: { labels: { color: isDark ? '#e5e7eb' : '#666' } },
                                    tooltip: {
                                        callbacks: {
                                            label: function(c) {
                                                return c.dataset.label + ': ' + formatCurrency(c.raw, 'TWD');
                                            }
                                        }
                                    }
                                }
                            }
                        });
                    } catch (e) {
                        console.error('Monthly Chart Error', e);
                    } finally {
                        sectionLoading.value = false;
                    }
                };
                
                if (isDarkMode.value) document.documentElement.classList.add('dark');
                window.addEventListener('resize', () => isMobile.value = window.innerWidth < 768);

                                // --- 2. 初始化與監聽 ---
                onMounted(() => {
                    const savedPrivacySetting = localStorage.getItem('app_default_privacy_hidden');
                    if (savedPrivacySetting === 'true') { defaultPrivacyHidden.value = true; showPrivacy.value = false; }
                    else { defaultPrivacyHidden.value = false; showPrivacy.value = true; }

                    const currentY = new Date().getFullYear();
                    const years = [];
                    for (let y = 2024; y <= currentY + 1; y++) {
                        years.push(y);
                    }
                    availableYears.value = years.sort((a, b) => b - a);
                    historyFilterYear.value = currentY;

                    const today = getLocalDate();
                    const d = new Date(); d.setDate(d.getDate() - 30);
                    const past = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split('T')[0];
                    const d90 = new Date(); d90.setDate(d90.getDate() - 90);
                    const past90 = new Date(d90.getTime() - d90.getTimezoneOffset() * 60000).toISOString().split('T')[0];
                    const yearStart = new Date(new Date().getFullYear(), 0, 1);
                    const localYearStart = new Date(yearStart.getTime() - yearStart.getTimezoneOffset() * 60000).toISOString().split('T')[0];

                    chartEndDate.value = today; chartStartDate.value = past;
                    divEndDate.value = today; divStartDate.value = localYearStart;
                    realizedEndDate.value = today; realizedStartDate.value = localYearStart;
                    transEndDate.value = today; transStartDate.value = past90;

                    auth.onAuthStateChanged((u) => {
                        user.value = u;
                        if (u) {
                            _initialStocksReady = false; _initialCashReady = false;
                            loadUserData(u.uid); 
                            fetchPreviousDayData(u.uid); 
                            fetchCash(u.uid); 
                            fetchNotes(u.uid); 
                            fetchLoans(u.uid); 
                            fetchRealEstate(u.uid); 
                            fetchFuturesData(u.uid);
                            fetchMutualFunds(u.uid); 
                        } else { 
                            stocks.value = []; 
                            realizedGains.value = []; 
                            dividendRecords.value = []; 
                            transactionHistory.value = []; 
                            cashData.value = { twd: 0, usd: 0, loan: 0 }; 
                            notes.value = []; 
                            loanList.value = []; 
                            realEstateList.value = []; 
                            futuresMargin.value = { twd: 0, usd: 0 }; 
                            futuresPositions.value = []; 
                            futuresTransactions.value = [];
                            if (unsubscribeFuturesPositions) unsubscribeFuturesPositions(); 
                            if (unsubscribeFuturesMargin) unsubscribeFuturesMargin(); 
                            if (unsubscribeFuturesTransactions) unsubscribeFuturesTransactions();
                        }
                    });
                    fetchExchangeRate();

                });

                // --- 3. 計算屬性 ---
                const sortedRealizedGains = computed(() => {
                    let data = realizedGains.value.slice();
                    if (realizedSearchQuery.value) {
                        const q = realizedSearchQuery.value.toUpperCase();
                        data = data.filter(r => (r.symbol && r.symbol.toUpperCase().includes(q)) || (r.name && r.name.toUpperCase().includes(q)));
                    }
                    data.sort((a, b) => {
                        let modifier = sortOrderRealized.value === 'desc' ? -1 : 1;
                        if (sortKeyRealized.value === 'date') return (new Date(a.date) - new Date(b.date)) * modifier;
                        if (sortKeyRealized.value === 'symbol') return (a.name || a.symbol).localeCompare(b.name || b.symbol) * modifier;
                        if (sortKeyRealized.value === 'pnl') return (a.pnl - b.pnl) * modifier;
                        return 0;
                    });
                    return data;
                });

                const sortedStocks = computed(() => {
                    let list = [...stocks.value];
                    if (hideZeroShares.value) {
                        list = list.filter(s => s.shares > 0);
                    }
                    return list.sort((a, b) => (b.currentPrice * b.shares * (b.currency === 'USD' ? exchangeRate.value : 1)) - (a.currentPrice * a.shares * (a.currency === 'USD' ? exchangeRate.value : 1)));
                });
                const twStockList = computed(() => sortedStocks.value.filter(s => s.currency === 'TWD'));
                const usStockList = computed(() => sortedStocks.value.filter(s => s.currency === 'USD'));
                const twStats = computed(() => calculateStats(twStockList.value));
                const usStats = computed(() => calculateStats(usStockList.value));
                const totalLoanBalance = computed(() => loanList.value.filter(l => l.status !== 'archived').reduce((acc, cur) => acc + (cur.balance || 0), 0));
                const totalMonthlyPayment = computed(() => loanList.value.filter(l => l.status !== 'archived').reduce((acc, cur) => acc + (cur.monthlyPayment || 0), 0));
                // v4.0.0: 房地產 computed
                const realEstateTotalMarket = computed(() => realEstateList.value.reduce((acc, re) => acc + (re.marketValue || 0), 0));
                const realEstateTotalMortgage = computed(() => {
                    const loanMap = {};
                    loanList.value.forEach(l => { loanMap[l.id] = l.balance || 0; });
                    return realEstateList.value.reduce((acc, re) => {
                        const ids = re.mortgageLoanIds || (re.mortgageLoanId ? [re.mortgageLoanId] : []);
                        const sum = ids.reduce((s, id) => s + (loanMap[id] || 0), 0);
                        return acc + sum;
                    }, 0);
                });
                const realEstateNetValue = computed(() => realEstateTotalMarket.value - realEstateTotalMortgage.value);
                const realEstateBookPnL = computed(() => realEstateList.value.reduce((acc, re) => acc + ((re.marketValue || 0) - (re.purchaseCost || 0)), 0));
                // --- 基金計算屬性 ---
                const mutualFundTotalCost = computed(() => mutualFundList.value.reduce((acc, f) => acc + ((f.costBasis || 0) * (f.currency === 'USD' ? exchangeRate.value : 1)), 0));
                const mutualFundTotalValue = computed(() => mutualFundList.value.reduce((acc, f) => acc + ((f.currentValue || 0) * (f.currency === 'USD' ? exchangeRate.value : 1)), 0));
                const mutualFundTotalPnL = computed(() => mutualFundTotalValue.value - mutualFundTotalCost.value);
                // --- 期貨相關計算屬性 ---
                const futuresTotalUnrealizedPnL = computed(() => {
                    return futuresPositions.value.reduce((acc, pos) => {
                        const diff = pos.direction === 'long' 
                            ? (pos.currentPrice - pos.entryPrice) 
                            : (pos.entryPrice - pos.currentPrice);
                        const pnl = diff * pos.contracts * pos.multiplier;
                        const rate = pos.currency === 'USD' ? exchangeRate.value : 1;
                        return acc + (pnl * rate);
                    }, 0);
                });

                const futuresTotalMarginCashTwd = computed(() => {
                    return (futuresMargin.value.twd || 0) + ((futuresMargin.value.usd || 0) * exchangeRate.value);
                });

                const futuresEquity = computed(() => {
                    return futuresTotalMarginCashTwd.value + futuresTotalUnrealizedPnL.value;
                });

                const futuresTotalMarginUsed = computed(() => {
                    return futuresPositions.value.reduce((acc, pos) => {
                        const rate = pos.currency === 'USD' ? exchangeRate.value : 1;
                        return acc + ((pos.marginUsed || 0) * rate);
                    }, 0);
                });

                const futuresTotalExposure = computed(() => {
                    return futuresPositions.value.reduce((acc, pos) => {
                        const val = pos.currentPrice * pos.contracts * pos.multiplier;
                        const rate = pos.currency === 'USD' ? exchangeRate.value : 1;
                        return acc + (val * rate);
                    }, 0);
                });

                const futuresRiskRatio = computed(() => {
                    if (futuresTotalMarginUsed.value <= 0) return 0;
                    return (futuresEquity.value / futuresTotalMarginUsed.value) * 100;
                });

                const futuresLeverageRatio = computed(() => {
                    const eq = futuresEquity.value;
                    if (eq <= 0) return 0;
                    return futuresTotalExposure.value / eq;
                });

                const grandTotalAssets = computed(() => {
                    const stockVal = twStats.value.value + (usStats.value.value * exchangeRate.value);
                    const cashVal = (cashData.value.twd || 0) + ((cashData.value.usd || 0) * exchangeRate.value);
                    const futuresVal = futuresEquity.value;
                    return stockVal + cashVal + realEstateTotalMarket.value + futuresVal + mutualFundTotalValue.value;
                });
                // v4.5.0: 曝險總額 (考慮正2等槓桿倍數)
                const grandTotalExposure = computed(() => {
                    const twExposure = twStockList.value.reduce((acc, s) => acc + (s.currentPrice * s.shares * (s.multiplier || 1)), 0);
                    const usExposure = usStockList.value.reduce((acc, s) => acc + (s.currentPrice * s.shares * (s.multiplier || 1)), 0) * exchangeRate.value;
                    const cashVal = (cashData.value.twd || 0) + ((cashData.value.usd || 0) * exchangeRate.value);
                    const futuresExp = futuresTotalExposure.value + Math.max(0, futuresEquity.value - futuresTotalMarginUsed.value);
                    return twExposure + usExposure + cashVal + realEstateTotalMarket.value + futuresExp + mutualFundTotalValue.value;
                });
                // v4.0.0: 淨資產 = 總資產 - 所有負債(貸款)
                const grandTotalValue = computed(() => grandTotalAssets.value - totalLoanBalance.value);
                const grandTotalPnL = computed(() => twStats.value.pnl + (usStats.value.pnl * exchangeRate.value) + futuresTotalUnrealizedPnL.value);
                
                // 金融資產（不含房地產）
                const financialAssets = computed(() => {
                    const stockVal = twStats.value.value + (usStats.value.value * exchangeRate.value);
                    const cashVal = (cashData.value.twd || 0) + ((cashData.value.usd || 0) * exchangeRate.value);
                    const futuresVal = futuresEquity.value;
                    return stockVal + cashVal + futuresVal;
                });
                // 金融負債（排除非投資用途的房貸與已封存帳戶）
                const financialLoans = computed(() => {
                    return loanList.value
                        .filter(l => l.status !== 'archived')
                        .filter(l => l.isInvestmentUse === true || l.type !== 'realestate')
                        .reduce((acc, cur) => acc + (cur.balance || 0), 0);
                });
                // 金融淨資產
                const financialNetWorth = computed(() => financialAssets.value - financialLoans.value);

                const activeLoans = computed(() => loanList.value.filter(l => l.status !== 'archived'));
                const archivedLoans = computed(() => loanList.value.filter(l => l.status === 'archived'));
                const showArchivedLoansList = ref(false);
                const toggleArchiveLoan = async (l) => {
                    const isArchiving = l.status !== 'archived';
                    if (isArchiving) {
                        if (l.balance > 0 && !confirm(`此帳戶尚有餘額 ${formatNumber(l.balance)}，結清會將餘額設為 0，確定結清並封存嗎？`)) {
                            return;
                        }
                        await db.collection('users').doc(user.value.uid).collection('loans').doc(l.id).update({ 
                            status: 'archived',
                            balance: 0
                        });
                    } else {
                        await db.collection('users').doc(user.value.uid).collection('loans').doc(l.id).update({ 
                            status: 'active'
                        });
                    }
                };

                // v4.4.0: 帳戶槓桿 = 金融資產 / 金融淨資產
                const leverageRatio = computed(() => {
                    if (financialNetWorth.value <= 0) return 1;
                    return financialAssets.value / financialNetWorth.value;
                });
                // 金融總曝險
                const financialExposure = computed(() => {
                    const twExposure = twStockList.value.reduce((acc, s) => acc + (s.currentPrice * s.shares * (s.multiplier || 1)), 0);
                    const usExposure = usStockList.value.reduce((acc, s) => acc + (s.currentPrice * s.shares * (s.multiplier || 1)), 0) * exchangeRate.value;
                    const cashVal = (cashData.value.twd || 0) + ((cashData.value.usd || 0) * exchangeRate.value);
                    const futuresExp = futuresTotalExposure.value + Math.max(0, futuresEquity.value - futuresTotalMarginUsed.value);
                    return twExposure + usExposure + cashVal + futuresExp;
                });

                // v4.5.0: 曝險比例 = 金融總曝險 / 金融淨資產
                const exposureRatio = computed(() => {
                    if (financialNetWorth.value <= 0) return 1;
                    return financialExposure.value / financialNetWorth.value;
                });
                const realizedTotalTw = computed(() => sortedRealizedGains.value.filter(r => r.currency === 'TWD').reduce((acc, cur) => acc + cur.pnl, 0));
                const realizedTotalUs = computed(() => sortedRealizedGains.value.filter(r => r.currency === 'USD').reduce((acc, cur) => acc + cur.pnl, 0));

                // v4.9.0: 計算台股與美股各自的 ETF、個股和現金的比例 (用於圖例百分比顯示)
                const twPieRatios = computed(() => {
                    const etf = twStockList.value.filter(s => s.isETF).reduce((a, s) => a + s.currentPrice * s.shares, 0);
                    const ind = twStockList.value.filter(s => !s.isETF).reduce((a, s) => a + s.currentPrice * s.shares, 0);
                    const cash = cashData.value.twd || 0;
                    const total = etf + ind + cash;
                    if (total === 0) return { etf: 0, ind: 0, cash: 0 };
                    return {
                        etf: ((etf / total) * 100).toFixed(1),
                        ind: ((ind / total) * 100).toFixed(1),
                        cash: ((cash / total) * 100).toFixed(1)
                    };
                });

                const usPieRatios = computed(() => {
                    const etf = usStockList.value.filter(s => s.isETF).reduce((a, s) => a + s.currentPrice * s.shares, 0);
                    const ind = usStockList.value.filter(s => !s.isETF).reduce((a, s) => a + s.currentPrice * s.shares, 0);
                    const cash = cashData.value.usd || 0;
                    const total = etf + ind + cash;
                    if (total === 0) return { etf: 0, ind: 0, cash: 0 };
                    return {
                        etf: ((etf / total) * 100).toFixed(1),
                        ind: ((ind / total) * 100).toFixed(1),
                        cash: ((cash / total) * 100).toFixed(1)
                    };
                });

                // Bug fix: 套用日期篩選，讓加總與下方列表一致
                const dividendRangeTw = computed(() => dividendRecords.value.filter(r => r.currency === 'TWD' && (!divStartDate.value || r.date >= divStartDate.value) && (!divEndDate.value || r.date <= divEndDate.value)).reduce((acc, cur) => acc + cur.amount, 0));
                const dividendRangeUs = computed(() => dividendRecords.value.filter(r => r.currency === 'USD' && (!divStartDate.value || r.date >= divStartDate.value) && (!divEndDate.value || r.date <= divEndDate.value)).reduce((acc, cur) => acc + cur.amount, 0));

                const sortedTransactions = computed(() => {
                    let data = transactionHistory.value;
                    if (transFilterType.value !== 'all') {
                        data = data.filter(tx => {
                            if (transFilterType.value === 'trade') return tx.type === 'buy' || tx.type === 'sell';
                            if (transFilterType.value === 'dividend') return tx.type === 'dividend';
                            if (transFilterType.value === 'fund') return tx.type === 'deposit' || tx.type === 'withdraw';
                            if (transFilterType.value === 'loan') return tx.type === 'borrow' || tx.type === 'repay';
                            return true;
                        });
                    }
                    if (transSearchQuery.value) {
                        const q = transSearchQuery.value.toUpperCase();
                        data = data.filter(tx => (tx.symbol && tx.symbol.toUpperCase().includes(q)) || (tx.name && tx.name.toUpperCase().includes(q)));
                    }
                    if (transStartDate.value) data = data.filter(tx => tx.date >= transStartDate.value);
                    if (transEndDate.value) data = data.filter(tx => tx.date <= transEndDate.value);
                    return data.slice().sort((a, b) => { let modifier = sortOrderTrans.value === 'desc' ? -1 : 1; if (sortKeyTrans.value === 'date') return (new Date(a.date) - new Date(b.date)) * modifier; if (sortKeyTrans.value === 'type') return a.type.localeCompare(b.type) * modifier; if (sortKeyTrans.value === 'symbol') return (a.name || a.symbol).localeCompare(b.name || b.symbol) * modifier; return 0; });
                });

                const sortedDividends = computed(() => {
                    let data = dividendRecords.value.slice();
                    if (divSearchQuery.value) {
                        const q = divSearchQuery.value.toUpperCase();
                        data = data.filter(d => (d.symbol && d.symbol.toUpperCase().includes(q)) || (d.name && d.name.toUpperCase().includes(q)));
                    }
                    return data.sort((a, b) => {
                        let modifier = sortOrderDiv.value === 'desc' ? -1 : 1;
                        if (sortKeyDiv.value === 'date') return (new Date(a.date) - new Date(b.date)) * modifier;
                        if (sortKeyDiv.value === 'symbol') return (a.name || a.symbol).localeCompare(b.name || b.symbol) * modifier;
                        if (sortKeyDiv.value === 'amount') return (a.amount - b.amount) * modifier;
                        return 0;
                    });
                });



                // --- 4. 輔助函數 ---
                const sortRealized = (key) => { if (sortKeyRealized.value === key) sortOrderRealized.value = sortOrderRealized.value === 'asc' ? 'desc' : 'asc'; else { sortKeyRealized.value = key; sortOrderRealized.value = 'desc'; } };
                const setDivRange = (range) => {
                    divRange.value = range;
                    const today = getLocalDate();
                    const y = new Date().getFullYear();
                    if (range === 'YTD') { divStartDate.value = `${y}-01-01`; divEndDate.value = today; }
                    else if (range === 'LAST_YEAR') { divStartDate.value = `${y - 1}-01-01`; divEndDate.value = `${y - 1}-12-31`; }
                    else if (range === '3M') { const d = new Date(); d.setMonth(d.getMonth() - 3); divStartDate.value = d.toISOString().split('T')[0]; divEndDate.value = today; }
                    else if (range === 'ALL') { divStartDate.value = '2020-01-01'; divEndDate.value = today; }
                    fetchDividends();
                };
                const setRealizedRange = (range) => {
                    realizedRange.value = range;
                    const today = getLocalDate();
                    const d = new Date();
                    const y = d.getFullYear();
                    const m = (d.getMonth() + 1).toString().padStart(2, '0');
                    if (range === 'TODAY') { realizedStartDate.value = today; realizedEndDate.value = today; }
                    else if (range === 'THIS_MONTH') { realizedStartDate.value = `${y}-${m}-01`; realizedEndDate.value = today; }
                    else if (range === 'YTD') { realizedStartDate.value = `${y}-01-01`; realizedEndDate.value = today; }
                    else if (range === 'LAST_YEAR') { realizedStartDate.value = `${y - 1}-01-01`; realizedEndDate.value = `${y - 1}-12-31`; }
                    else if (range === '3M') { const d2 = new Date(); d2.setMonth(d2.getMonth() - 3); realizedStartDate.value = d2.toISOString().split('T')[0]; realizedEndDate.value = today; }
                    else if (range === 'ALL') { realizedStartDate.value = '2020-01-01'; realizedEndDate.value = today; }
                    fetchRealizedGains();
                };

                const setChartRange = (range) => {
                    currentRange.value = range;
                    const end = new Date();
                    let start = new Date();
                    if (range === '1M') start.setMonth(start.getMonth() - 1);
                    else if (range === '3M') start.setMonth(start.getMonth() - 3);
                    else if (range === '6M') start.setMonth(start.getMonth() - 6);
                    else if (range === 'YTD') start = new Date(new Date().getFullYear(), 0, 1);
                    else if (range === 'ALL') start = new Date(2020, 0, 1);
                    const offset = start.getTimezoneOffset() * 60000;
                    const endOffset = end.getTimezoneOffset() * 60000;
                    chartStartDate.value = new Date(start.getTime() - offset).toISOString().split('T')[0];
                    chartEndDate.value = new Date(end.getTime() - endOffset).toISOString().split('T')[0];
                    drawChart();
                };

                const toggleDarkMode = () => { isDarkMode.value = !isDarkMode.value; localStorage.setItem('darkMode', isDarkMode.value); document.documentElement.classList.toggle('dark'); };
                const saveSettings = () => { localStorage.setItem('app_default_privacy_hidden', defaultPrivacyHidden.value); localStorage.setItem('hideZeroShares', hideZeroShares.value); };

                watch(isDarkMode, () => {
                    if (activeSection.value === 'overview') {
                        setTimeout(() => {
                            if (overviewTab.value === 'trend') drawChart();
                            else if (overviewTab.value === 'pie') drawPieCharts();
                        }, 100);
                    }
                    if (activeSection.value === 'performance' && performanceTab.value === 'monthly') {
                        setTimeout(drawMonthlyChart, 100);
                    }
                });

                watch(performanceTab, (newTab) => {
                    if (newTab === 'monthly') {
                        setTimeout(drawMonthlyChart, 100);
                    } else if (newTab === 'transactions') {
                        fetchTransactions();
                    }
                });

                watch(overviewTab, (newTab) => {
                    if (activeSection.value === 'overview') {
                        setTimeout(() => {
                            if (newTab === 'trend') drawChart();
                            else if (newTab === 'pie') drawPieCharts();
                        }, 100);
                    }
                });

                watch(activeSection, (newSection) => {
                    if (newSection === 'overview') {
                        setTimeout(() => {
                            if (overviewTab.value === 'trend') drawChart();
                            else if (overviewTab.value === 'pie') drawPieCharts();
                        }, 100);
                    }
                    if (newSection === 'performance') {
                        fetchRealizedGains();
                        fetchDividends();
                        if (performanceTab.value === 'monthly') {
                            setTimeout(drawMonthlyChart, 100);
                        } else if (performanceTab.value === 'transactions') {
                            fetchTransactions();
                        }
                    }
                });

                const toggleSection = (s) => {
                    activeSection.value = s;
                };
                const jumpToFundHistory = () => { setTimeout(() => { const el = document.querySelector('[data-section="fund-history"]'); if (el) el.scrollIntoView({ behavior: 'smooth' }); }, 100); };
                const loadUserData = (uid) => {
                    if (unsubscribe) unsubscribe(); unsubscribe = db.collection('users').doc(uid).collection('stocks').onSnapshot(snap => {
                        stocks.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                        // 只有在現金已載入後才儲存快照，避免寫入現金=0的錯誤數字
                        if (stocks.value.length > 0 && _initialCashReady) saveDailySnapshot();
                        if (!_initialStocksReady) { _initialStocksReady = true; _scheduleInitialChart(); }
                        // v3.6.0: 自動偵測未分類股票的市場類型（背景執行，不阻塞 UI）
                        const unclassified = stocks.value.filter(s => !s.marketType && s.currency !== 'USD');
                        // v4.8.0: 同時偵測已分類但市場可能有變動的股票（如興櫃轉上市）
                        const misclassified = stocks.value.filter(s => (s.marketType === 'tse' || s.marketType === 'otc' || s.marketType === 'esb') && s.currency !== 'USD');
                        if (unclassified.length > 0) setTimeout(() => autoDetectMarketTypes(unclassified), 5000);
                        if (misclassified.length > 0) setTimeout(() => autoCorrectMarketTypes(misclassified), 12000);
                    });
                };
                const fetchCash = (uid) => { if (unsubscribeCash) unsubscribeCash(); unsubscribeCash = db.collection('users').doc(uid).collection('portfolio').doc('cash').onSnapshot(doc => { if (doc.exists) cashData.value = doc.data(); else cashData.value = { twd: 0, usd: 0, loan: 0 }; if (cashData.value.loan > 0 && loanList.value.length === 0) { setTimeout(() => migrateLegacyLoan(uid, cashData.value.loan), 1000); } if (!_initialCashReady) { _initialCashReady = true; _scheduleInitialChart(); } else { setTimeout(saveDailySnapshot, 500); } }); };
                const fetchLoans = (uid) => { if (unsubscribeLoans) unsubscribeLoans(); unsubscribeLoans = db.collection('users').doc(uid).collection('loans').onSnapshot(snap => { loanList.value = snap.docs.map(d => ({ id: d.id, ...d.data() })); }); };
                const migrateLegacyLoan = async (uid, amount) => { if (loanList.value.length > 0) return; await db.collection('users').doc(uid).collection('loans').add({ name: '原有借款', balance: amount, currency: 'TWD' }); await db.collection('users').doc(uid).collection('portfolio').doc('cash').update({ loan: 0 }); };
                const fetchNotes = (uid) => { if (unsubscribeNotes) unsubscribeNotes(); unsubscribeNotes = db.collection('users').doc(uid).collection('notes').orderBy('date', 'desc').onSnapshot(snap => { notes.value = snap.docs.map(d => ({ id: d.id, ...d.data() })); }); };
                // v4.0.0: 房地產 CRUD
                const fetchRealEstate = (uid) => { if (unsubscribeRealEstate) unsubscribeRealEstate(); unsubscribeRealEstate = db.collection('users').doc(uid).collection('real_estate').onSnapshot(snap => { realEstateList.value = snap.docs.map(d => ({ id: d.id, ...d.data() })); }); };
                let unsubscribeMutualFunds = null;
                const fetchMutualFunds = (uid) => { if (unsubscribeMutualFunds) unsubscribeMutualFunds(); unsubscribeMutualFunds = db.collection('users').doc(uid).collection('funds').onSnapshot(snap => { mutualFundList.value = snap.docs.map(d => ({ id: d.id, ...d.data() })); }); };
                const openMutualFundModal = (fund) => {
                    if (fund) {
                        mutualFundForm.value = { ...fund };
                    } else {
                        mutualFundForm.value = { id: null, name: '', currency: 'TWD', costBasis: '', currentValue: '', purchaseDate: '', note: '' };
                    }
                    showMutualFundModal.value = true;
                };
                const saveMutualFund = async () => {
                    if (!user.value || !mutualFundForm.value.name) return alert('請輸入基金名稱');
                    const data = {
                        name: mutualFundForm.value.name,
                        currency: mutualFundForm.value.currency || 'TWD',
                        costBasis: parseFloat(mutualFundForm.value.costBasis) || 0,
                        currentValue: parseFloat(mutualFundForm.value.currentValue) || 0,
                        purchaseDate: mutualFundForm.value.purchaseDate || '',
                        note: mutualFundForm.value.note || '',
                    };
                    const col = db.collection('users').doc(user.value.uid).collection('funds');
                    if (mutualFundForm.value.id) {
                        await col.doc(mutualFundForm.value.id).update(data);
                    } else {
                        await col.add(data);
                    }
                    showMutualFundModal.value = false;
                    setTimeout(saveDailySnapshot, 500);
                };
                const deleteMutualFund = async (id) => {
                    if (!confirm('確定刪除此基金？')) return;
                    await db.collection('users').doc(user.value.uid).collection('funds').doc(id).delete();
                    setTimeout(saveDailySnapshot, 500);
                };
                  const autoFetchTaiexIndexPrice = async () => {
                      futuresForm.value.currentPrice = '查詢中...';
                      try {
                          const sym = (futuresForm.value.symbol || '').toUpperCase();
                          let price = null;
                          if (sym === 'CDF' || sym === 'QDF') {
                              // 抓取台積電現貨價格作為個股期貨的洗價現價
                              const tsmcData = await getYahooData('2330');
                              price = tsmcData?.regularMarketPrice;
                          } else {
                              let targetSymbol = 'TWF:TXF:FUTURES'; // 預設大台近全
                              if (sym.startsWith('MTX') || sym.startsWith('MXF') || sym.startsWith('TMF')) {
                                  targetSymbol = 'TWF:MXF:FUTURES'; // 小台/微台近全
                              }
                              const url = CF_PROXY + encodeURIComponent(`https://ws.api.cnyes.com/ws/api/v1/quote/quotes/${targetSymbol}`);
                              const resp = await fetch(url);
                              const data = await resp.json();
                              price = data?.data?.[0]?.['6'];
                          }
                          if (price) {
                              futuresForm.value.currentPrice = Number(price);
                          } else {
                              // 備援：抓取加權指數現貨
                              const fallbackUrl = CF_PROXY + encodeURIComponent('https://query1.finance.yahoo.com/v8/finance/chart/^TWII');
                              const fbResp = await fetch(fallbackUrl);
                              const fbData = await fbResp.json();
                              const fbPrice = fbData.chart.result[0].meta.regularMarketPrice;
                              if (fbPrice) {
                                  futuresForm.value.currentPrice = Math.round(fbPrice);
                              } else {
                                  futuresForm.value.currentPrice = '';
                                  alert('無法獲取期貨報價或指數現貨價格');
                              }
                          }
                      } catch (e) {
                          futuresForm.value.currentPrice = '';
                          console.error(e);
                          alert('獲取報價失敗：' + e.message);
                      }
                  };
                  const fetchFuturesPricesDirect = async () => {
                      if (!user.value) return;
                      const targetPositions = futuresPositions.value.filter(pos => {
                          const sym = pos.symbol.toUpperCase();
                          return sym.startsWith('TX') || sym.startsWith('MTX') || sym.startsWith('MXF') || sym.startsWith('TMF') || sym.startsWith('CDF') || sym.startsWith('QDF');
                      });
                      if (targetPositions.length === 0) {
                          alert('您目前沒有需要更新價格的台股期貨部位 (如台指期、小台、微台、台積期等)');
                          return;
                      }
                      futuresLoading.value = true;
                      try {
                          // 同步抓取大台近全、小台近全、與台積電現貨
                          const txUrl = CF_PROXY + encodeURIComponent('https://ws.api.cnyes.com/ws/api/v1/quote/quotes/TWF:TXF:FUTURES');
                          const mxfUrl = CF_PROXY + encodeURIComponent('https://ws.api.cnyes.com/ws/api/v1/quote/quotes/TWF:MXF:FUTURES');
                          const [txResp, mxfResp, tsmcData] = await Promise.all([
                              fetch(txUrl).then(r => r.json()),
                              fetch(mxfUrl).then(r => r.json()),
                              getYahooData('2330')
                          ]);
                          const txPrice = txResp?.data?.[0]?.['6'];
                          const mxfPrice = mxfResp?.data?.[0]?.['6'];
                          const tsmcPrice = tsmcData?.regularMarketPrice;
                          
                          if (!txPrice && !mxfPrice && !tsmcPrice) {
                              alert('無法取得期貨即時報價，請稍後再試。');
                              return;
                          }
                          const batch = db.batch();
                          let updatedCount = 0;
                          targetPositions.forEach(pos => {
                              const sym = pos.symbol.toUpperCase();
                              let price = null;
                              if (sym.startsWith('TX')) {
                                  price = txPrice;
                              } else if (sym.startsWith('MTX') || sym.startsWith('MXF') || sym.startsWith('TMF')) {
                                  price = mxfPrice || txPrice;
                              } else if (sym.startsWith('CDF') || sym.startsWith('QDF')) {
                                  price = tsmcPrice;
                              }
                              if (price) {
                                  pos.currentPrice = Number(price);
                                  const ref = db.collection('users').doc(user.value.uid).collection('futures_positions').doc(pos.id);
                                  batch.update(ref, { currentPrice: Number(price), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
                                  updatedCount++;
                              }
                          });
                          if (updatedCount > 0) {
                              await batch.commit();
                              setTimeout(saveDailySnapshot, 500);
                              let alertMsg = `期貨價格更新完成！\n已將 ${updatedCount} 筆部位之價格同步為即時價格：`;
                              if (txPrice) alertMsg += `\n台指期近全 (大台)：${Math.round(txPrice)} 點`;
                              if (mxfPrice) alertMsg += `\n小台/微台近全：${Math.round(mxfPrice)} 點`;
                              if (tsmcPrice) alertMsg += `\n台積電現貨 (台積期/小台積期)：${tsmcPrice} 元`;
                              alert(alertMsg);
                          } else {
                              alert('沒有符合更新條件的期貨部位。');
                          }
                      } catch (e) {
                          console.error(e);
                          alert('更新期貨價格失敗：' + e.message);
                      } finally {
                          futuresLoading.value = false;
                      }
                  };
                 const fetchFuturesTransactions = (uid) => {
                     if (unsubscribeFuturesTransactions) unsubscribeFuturesTransactions();
                     unsubscribeFuturesTransactions = db.collection('users').doc(uid)
                         .collection('futures_transactions')
                         .orderBy('date', 'desc')
                         .onSnapshot(snap => {
                             futuresTransactions.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                         }, err => {
                             console.error('Error fetching futures transactions:', err);
                         });
                 };

                 const fetchFuturesData = (uid) => {
                     if (unsubscribeFuturesMargin) unsubscribeFuturesMargin();
                     unsubscribeFuturesMargin = db.collection('users').doc(uid).collection('portfolio').doc('futures_margin').onSnapshot(doc => {
                         if (doc.exists) futuresMargin.value = doc.data();
                         else futuresMargin.value = { twd: 0, usd: 0 };
                     });
                     if (unsubscribeFuturesPositions) unsubscribeFuturesPositions();
                     unsubscribeFuturesPositions = db.collection('users').doc(uid).collection('futures_positions').onSnapshot(snap => {
                         futuresPositions.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                     });
                     fetchFuturesTransactions(uid);
                 };
                const openRealEstateModal = (re) => {
                    if (re) {
                        // 相容舊資料（mortgageLoanId 單一 string）
                        const ids = re.mortgageLoanIds || (re.mortgageLoanId ? [re.mortgageLoanId] : []);
                        realEstateForm.value = { ...re, mortgageLoanIds: ids };
                    } else {
                        realEstateForm.value = { id: null, name: '', address: '', purchaseDate: getLocalDate(), purchaseCost: 0, marketValue: 0, mortgageLoanIds: [], note: '' };
                    }
                    showRealEstateModal.value = true;
                };
                const saveRealEstate = async () => {
                    if (!user.value || !realEstateForm.value.name) return alert('請輸入房產名稱');
                    if (!realEstateForm.value.marketValue) return alert('請輸入估計市值');
                    const data = {
                        name: realEstateForm.value.name,
                        address: realEstateForm.value.address || '',
                        purchaseDate: realEstateForm.value.purchaseDate || '',
                        purchaseCost: realEstateForm.value.purchaseCost || 0,
                        marketValue: realEstateForm.value.marketValue || 0,
                        mortgageLoanIds: realEstateForm.value.mortgageLoanIds || [],
                        note: realEstateForm.value.note || '',
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                    };
                    const col = db.collection('users').doc(user.value.uid).collection('real_estate');
                    if (realEstateForm.value.id) await col.doc(realEstateForm.value.id).update(data);
                    else await col.add(data);
                    showRealEstateModal.value = false;
                    setTimeout(saveDailySnapshot, 500);
                };
                const deleteRealEstate = async (re) => {
                    if (!confirm(`確定刪除「${re.name}」？`)) return;
                    await db.collection('users').doc(user.value.uid).collection('real_estate').doc(re.id).delete();
                    setTimeout(saveDailySnapshot, 500);
                };

                // --- 期貨相關 CRUD 與記帳邏輯 ---
                const openFuturesModal = (pos) => {
                    if (pos) {
                        futuresForm.value = { ...pos };
                    } else {
                        futuresForm.value = {
                            id: null,
                            symbol: '',
                            expiry: '',
                            direction: 'long',
                            contracts: '',
                            entryPrice: '',
                            currentPrice: '',
                            multiplier: '',
                            marginUsed: '',
                            currency: 'TWD',
                            note: ''
                        };
                    }
                    showFuturesModal.value = true;
                };

                const onFuturesSymbolChange = () => {
                    const sym = futuresForm.value.symbol;
                    if (sym === 'TX') {
                        futuresForm.value.multiplier = 200;
                        futuresForm.value.marginUsed = 179000;
                    } else if (sym === 'MTX') {
                        futuresForm.value.multiplier = 50;
                        futuresForm.value.marginUsed = 45000;
                    } else if (sym === 'TMF') {
                        futuresForm.value.multiplier = 10;
                        futuresForm.value.marginUsed = 11100;
                    } else if (sym === 'CDF') {
                        futuresForm.value.multiplier = 2000;
                        futuresForm.value.marginUsed = 300000; // 台積電期貨 2000股 (預估保證金)
                    } else if (sym === 'QDF') {
                        futuresForm.value.multiplier = 100;
                        futuresForm.value.marginUsed = 15000; // 小台積電期貨 100股 (預估保證金)
                    }
                };
                const saveFuturesPosition = async () => {
                    if (!user.value) return;
                    const f = futuresForm.value;
                    if (!f.symbol) return alert('請輸入商品代號');
                    if (!f.contracts || f.contracts <= 0) return alert('請輸入大於 0 的口數');
                    if (!f.entryPrice || f.entryPrice <= 0) return alert('請輸入大於 0 的建倉價格');
                    if (!f.currentPrice || f.currentPrice <= 0) return alert('請輸入大於 0 的目前價格');
                    if (!f.multiplier || f.multiplier <= 0) return alert('請輸入大於 0 的合約乘數');
                    if (!f.marginUsed || f.marginUsed < 0) return alert('請輸入正確的佔用保證金');

                    const data = {
                        symbol: f.symbol.toUpperCase(),
                        expiry: f.expiry || '',
                        direction: f.direction,
                        contracts: Number(f.contracts),
                        entryPrice: Number(f.entryPrice),
                        currentPrice: Number(f.currentPrice),
                        multiplier: Number(f.multiplier),
                        marginUsed: Number(f.marginUsed),
                        currency: f.currency,
                        note: f.note || '',
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                    };

                    const col = db.collection('users').doc(user.value.uid).collection('futures_positions');
                    if (f.id) {
                        await col.doc(f.id).update(data);
                    } else {
                        const newPosRef = col.doc();
                        await db.collection('users').doc(user.value.uid).collection('futures_transactions').add({
                            type: 'open',
                            symbol: data.symbol,
                            expiry: data.expiry,
                            direction: data.direction,
                            contracts: data.contracts,
                            price: data.entryPrice,
                            multiplier: data.multiplier,
                            marginUsed: data.marginUsed,
                            currency: data.currency,
                            date: getLocalDate(),
                            note: data.note || '期貨建倉',
                            positionId: newPosRef.id,
                            timestamp: firebase.firestore.FieldValue.serverTimestamp()
                        });
                        await newPosRef.set(data);
                    }
                    showFuturesModal.value = false;
                    setTimeout(saveDailySnapshot, 500);
                };

                const deleteFuturesPosition = async (pos) => {
                    if (!confirm(`確定要刪除該筆期貨部位「${pos.symbol}」？(此操作僅刪除紀錄，不計算平倉盈虧)`)) return;
                    await db.collection('users').doc(user.value.uid).collection('futures_positions').doc(pos.id).delete();
                    setTimeout(saveDailySnapshot, 500);
                };

                const closeFuturesPosition = async (pos) => {
                    const closePriceStr = prompt(`請輸入「${pos.symbol}」的平倉點數 / 價格：`, pos.currentPrice);
                    if (closePriceStr === null) return;
                    const closePrice = Number(closePriceStr);
                    if (isNaN(closePrice) || closePrice <= 0) return alert('請輸入有效點數');

                    const diff = pos.direction === 'long' 
                        ? (closePrice - pos.entryPrice) 
                        : (pos.entryPrice - closePrice);
                    const pnl = diff * pos.contracts * pos.multiplier;

                    if (!confirm(`平倉價格: ${closePrice}\n預估盈虧: ${pos.currency === 'USD' ? '$' : 'NT$'} ${formatNumber(pnl)}\n\n確定執行平倉嗎？`)) return;

                    // 1. 寫入已實現損益 (產生 doc ID 並設定)
                    const realizedRef = db.collection('users').doc(user.value.uid).collection('realized_gains').doc();
                    await realizedRef.set({
                        symbol: pos.symbol,
                        name: `${pos.symbol}${pos.expiry ? ' ' + pos.expiry : ''} (${pos.direction === 'long' ? '多' : '空'}平)`,
                        pnl: pnl,
                        date: getLocalDate(),
                        currency: pos.currency || 'TWD',
                        shares: pos.contracts,
                        buyPrice: pos.entryPrice,
                        sellPrice: closePrice,
                        memo: pos.note || '期貨平倉'
                    });

                    // 1b. 寫入期貨交易歷史紀錄
                    await db.collection('users').doc(user.value.uid).collection('futures_transactions').add({
                        type: 'close',
                        symbol: pos.symbol,
                        expiry: pos.expiry || '',
                        direction: pos.direction,
                        contracts: pos.contracts,
                        entryPrice: pos.entryPrice,
                        closePrice: closePrice,
                        multiplier: pos.multiplier,
                        marginUsed: pos.marginUsed || 0,
                        pnl: pnl,
                        currency: pos.currency,
                        date: getLocalDate(),
                        note: pos.note || '期貨平倉',
                        realizedGainsId: realizedRef.id,
                        timestamp: firebase.firestore.FieldValue.serverTimestamp()
                    });

                    // 2. 將盈虧灌回期貨保證金帳戶
                    const curMargin = { ...futuresMargin.value };
                    if (pos.currency === 'USD') {
                        curMargin.usd = (curMargin.usd || 0) + pnl;
                    } else {
                        curMargin.twd = (curMargin.twd || 0) + pnl;
                    }
                    await db.collection('users').doc(user.value.uid).collection('portfolio').doc('futures_margin').set(curMargin, { merge: true });

                    // 3. 刪除該部位
                    await db.collection('users').doc(user.value.uid).collection('futures_positions').doc(pos.id).delete();

                    setTimeout(saveDailySnapshot, 500);
                    alert('平倉成功！平倉損益已歸檔，並調整保證金帳戶餘額。');
                };

                const deleteFuturesTransaction = async (tx) => {
                    if (!confirm(`確定要刪除此筆交易紀錄？\n(這將撤銷此動作對應的資金或部位狀態！)`)) return;
                    
                    const uid = user.value.uid;
                    const batch = db.batch();
                    const txRef = db.collection('users').doc(uid).collection('futures_transactions').doc(tx.id);
                    batch.delete(txRef);
                    
                    try {
                        const curMargin = { ...futuresMargin.value };
                        
                        if (tx.type === 'deposit') {
                            if (tx.currency === 'USD') {
                                curMargin.usd = Math.max((curMargin.usd || 0) - tx.amount, 0);
                            } else {
                                curMargin.twd = Math.max((curMargin.twd || 0) - tx.amount, 0);
                            }
                            const marginRef = db.collection('users').doc(uid).collection('portfolio').doc('futures_margin');
                            batch.set(marginRef, curMargin, { merge: true });
                            
                            const cashSnap = await db.collection('users').doc(uid)
                                .collection('transactions')
                                .where('symbol', '==', 'CASH')
                                .where('totalAmount', '==', tx.amount)
                                .where('currency', '==', tx.currency)
                                .where('date', '==', tx.date)
                                .where('type', '==', 'withdraw')
                                .get();
                            
                            if (!cashSnap.empty) {
                                batch.delete(cashSnap.docs[0].ref);
                                const curCash = { ...cashData.value };
                                if (tx.currency === 'USD') {
                                    curCash.usd = (curCash.usd || 0) + tx.amount;
                                } else {
                                    curCash.twd = (curCash.twd || 0) + tx.amount;
                                }
                                const cashRef = db.collection('users').doc(uid).collection('portfolio').doc('cash');
                                batch.set(cashRef, curCash, { merge: true });
                            }
                        } 
                        else if (tx.type === 'withdraw') {
                            if (tx.currency === 'USD') {
                                curMargin.usd = (curMargin.usd || 0) + tx.amount;
                            } else {
                                curMargin.twd = (curMargin.twd || 0) + tx.amount;
                            }
                            const marginRef = db.collection('users').doc(uid).collection('portfolio').doc('futures_margin');
                            batch.set(marginRef, curMargin, { merge: true });
                            
                            const cashSnap = await db.collection('users').doc(uid)
                                .collection('transactions')
                                .where('symbol', '==', 'CASH')
                                .where('totalAmount', '==', tx.amount)
                                .where('currency', '==', tx.currency)
                                .where('date', '==', tx.date)
                                .where('type', '==', 'deposit')
                                .get();
                            
                            if (!cashSnap.empty) {
                                batch.delete(cashSnap.docs[0].ref);
                                const curCash = { ...cashData.value };
                                if (tx.currency === 'USD') {
                                    curCash.usd = Math.max((curCash.usd || 0) - tx.amount, 0);
                                } else {
                                    curCash.twd = Math.max((curCash.twd || 0) - tx.amount, 0);
                                }
                                const cashRef = db.collection('users').doc(uid).collection('portfolio').doc('cash');
                                batch.set(cashRef, curCash, { merge: true });
                            }
                        }
                        else if (tx.type === 'open') {
                            if (tx.positionId) {
                                const posRef = db.collection('users').doc(uid).collection('futures_positions').doc(tx.positionId);
                                batch.delete(posRef);
                            }
                        }
                        else if (tx.type === 'close') {
                            if (tx.currency === 'USD') {
                                curMargin.usd = (curMargin.usd || 0) - (tx.pnl || 0);
                            } else {
                                curMargin.twd = (curMargin.twd || 0) - (tx.pnl || 0);
                            }
                            const marginRef = db.collection('users').doc(uid).collection('portfolio').doc('futures_margin');
                            batch.set(marginRef, curMargin, { merge: true });
                            
                            if (tx.realizedGainsId) {
                                const rgRef = db.collection('users').doc(uid).collection('realized_gains').doc(tx.realizedGainsId);
                                batch.delete(rgRef);
                            }
                            
                            const posRef = db.collection('users').doc(uid).collection('futures_positions').doc();
                            batch.set(posRef, {
                                symbol: tx.symbol,
                                expiry: tx.expiry || '',
                                direction: tx.direction,
                                contracts: tx.contracts,
                                entryPrice: tx.entryPrice,
                                currentPrice: tx.closePrice || tx.entryPrice,
                                multiplier: tx.multiplier,
                                marginUsed: tx.marginUsed || 0,
                                currency: tx.currency,
                                note: tx.note || '',
                                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                             });
                         }
                         
                         await batch.commit();
                         setTimeout(saveDailySnapshot, 500);
                         alert('刪除交易紀錄成功，相關狀態已連動復原！');
                     } catch (err) {
                         console.error('Error deleting transaction:', err);
                         alert('刪除失敗：' + err.message);
                     }
                 };

                const openFuturesMarginModal = () => {
                    futuresMarginForm.value = {
                        amount: '',
                        currency: 'TWD',
                        type: 'deposit',
                        syncCash: true,
                        note: ''
                    };
                    showFuturesMarginModal.value = true;
                };

                const adjustFuturesMargin = async () => {
                    const formVal = futuresMarginForm.value;
                    const amt = Number(formVal.amount);
                    if (isNaN(amt) || amt <= 0) return alert('請輸入有效金額');

                    const curMargin = { ...futuresMargin.value };
                    const curCash = { ...cashData.value };

                    if (formVal.type === 'deposit') {
                        // 檢查銀行活存現金是否足夠連動
                        if (formVal.syncCash) {
                            if (formVal.currency === 'USD') {
                                if ((curCash.usd || 0) < amt) return alert('銀行美金活存餘額不足！');
                                curCash.usd = (curCash.usd || 0) - amt;
                            } else {
                                if ((curCash.twd || 0) < amt) return alert('銀行台幣活存餘額不足！');
                                curCash.twd = (curCash.twd || 0) - amt;
                            }
                        }

                        // 入金至期貨保證金
                        if (formVal.currency === 'USD') {
                            curMargin.usd = (curMargin.usd || 0) + amt;
                        } else {
                            curMargin.twd = (curMargin.twd || 0) + amt;
                        }

                    } else if (formVal.type === 'withdraw') {
                        // 檢查期貨保證金是否足夠出金
                        if (formVal.currency === 'USD') {
                            if ((curMargin.usd || 0) < amt) return alert('期貨美金保證金餘額不足！');
                            curMargin.usd = (curMargin.usd || 0) - amt;
                        } else {
                            if ((curMargin.twd || 0) < amt) return alert('期貨台幣保證金餘額不足！');
                            curMargin.twd = (curMargin.twd || 0) - amt;
                        }

                        // 出金至銀行活存
                        if (formVal.syncCash) {
                            if (formVal.currency === 'USD') {
                                curCash.usd = (curCash.usd || 0) + amt;
                            } else {
                                curCash.twd = (curCash.twd || 0) + amt;
                            }
                        }
                    }

                    // 1. 更新期貨保證金
                    await db.collection('users').doc(user.value.uid).collection('portfolio').doc('futures_margin').set(curMargin, { merge: true });

                    // 1b. 寫入期貨保證金劃轉流水帳
                    await db.collection('users').doc(user.value.uid).collection('futures_transactions').add({
                        type: formVal.type,
                        symbol: 'MARGIN',
                        amount: amt,
                        currency: formVal.currency,
                        date: getLocalDate(),
                        note: formVal.note || (formVal.type === 'deposit' ? '保證金存入' : '保證金提出'),
                        timestamp: firebase.firestore.FieldValue.serverTimestamp()
                    });

                    // 2. 若勾選同步，更新銀行活存
                    if (formVal.syncCash) {
                        await db.collection('users').doc(user.value.uid).collection('portfolio').doc('cash').set(curCash, { merge: true });

                        // 3. 寫入銀行現金交易流水帳 (CASH 紀錄)
                        await db.collection('users').doc(user.value.uid).collection('transactions').add({
                            type: formVal.type === 'deposit' ? 'withdraw' : 'deposit',
                            symbol: 'CASH',
                            name: formVal.type === 'deposit' ? '轉出至期貨保證金' : '期貨保證金轉回',
                            shares: 0,
                            totalAmount: amt,
                            currency: formVal.currency,
                            date: getLocalDate(),
                            memo: formVal.note || '期貨保證金劃轉'
                        });
                    }

                    showFuturesMarginModal.value = false;
                    alert('保證金調整成功！');
                    setTimeout(saveDailySnapshot, 500);
                };
                const getLoanName = (loanId) => { const l = loanList.value.find(x => x.id === loanId); return l ? l.name : '未知帳戶'; };
                const getReMortgageTotal = (re) => {
                    const ids = re.mortgageLoanIds || (re.mortgageLoanId ? [re.mortgageLoanId] : []);
                    return ids.reduce((s, id) => {
                        const l = loanList.value.find(x => x.id === id);
                        return s + (l ? (l.balance || 0) : 0);
                    }, 0);
                };
                const getReMortgageLoans = (re) => {
                    const ids = re.mortgageLoanIds || (re.mortgageLoanId ? [re.mortgageLoanId] : []);
                    return ids.map(id => loanList.value.find(x => x.id === id)).filter(Boolean);
                };
                const toggleReMortgageLoan = (loanId) => {
                    const ids = realEstateForm.value.mortgageLoanIds || [];
                    const idx = ids.indexOf(loanId);
                    if (idx === -1) realEstateForm.value.mortgageLoanIds = [...ids, loanId];
                    else realEstateForm.value.mortgageLoanIds = ids.filter(id => id !== loanId);
                };
                const login = () => auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(alert);
                const logout = () => auth.signOut();

                // --- 5. 匯出/匯入/清除 ---

                // v3.9.0: Google Drive 相關
                const driveLoading = ref(false);
                const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
                const PICKER_API_KEY = 'AIzaSyAh94_Z-wA_riNIXmn_btCXbTtaZny1CQg'; // 同 Firebase API Key

                // 取得含 Drive scope 的 Google access token
                const getDriveAccessToken = async () => {
                    const provider = new firebase.auth.GoogleAuthProvider();
                    provider.addScope(DRIVE_SCOPE);
                    const result = await auth.signInWithPopup(provider);
                    return result.credential.accessToken;
                };

                // 載入 gapi (picker)
                const loadGapi = () => new Promise((resolve, reject) => {
                    if (typeof gapi === 'undefined') return reject(new Error('Google API 未載入'));
                    gapi.load('picker', { callback: resolve, onerror: reject });
                });

                // v3.9.0: 備份到 Google Drive
                const exportDataToDrive = async () => {
                    if (!user.value || driveLoading.value) return;
                    driveLoading.value = true;
                    try {
                        const accessToken = await getDriveAccessToken();
                        const uid = user.value.uid;
                        const allStocks = await db.collection('users').doc(uid).collection('stocks').get();
                        const allTrans = await db.collection('users').doc(uid).collection('transactions').get();
                        const allRealized = await db.collection('users').doc(uid).collection('realized_gains').get();
                        const allDividends = await db.collection('users').doc(uid).collection('dividends').get();
                        const allHistory = await db.collection('users').doc(uid).collection('history').orderBy('date').get();
                        const allNotes = await db.collection('users').doc(uid).collection('notes').get();
                        const allLoans = await db.collection('users').doc(uid).collection('loans').get();
                        const allRealEstate = await db.collection('users').doc(uid).collection('real_estate').get();
                        const cashDoc = await db.collection('users').doc(uid).collection('portfolio').doc('cash').get();
                        const obj = {
                            stocks: allStocks.docs.map(d => ({ id: d.id, ...d.data() })),
                            transactions: allTrans.docs.map(d => ({ id: d.id, ...d.data() })),
                            realized: allRealized.docs.map(d => ({ id: d.id, ...d.data() })),
                            dividends: allDividends.docs.map(d => ({ id: d.id, ...d.data() })),
                            history: allHistory.docs.map(d => d.data()),
                            cash: cashDoc.exists ? cashDoc.data() : { twd: 0, usd: 0, loan: 0 },
                            notes: allNotes.docs.map(d => ({ id: d.id, ...d.data() })),
                            loans: allLoans.docs.map(d => ({ id: d.id, ...d.data() })),
                            real_estate: allRealEstate.docs.map(d => ({ id: d.id, ...d.data() }))
                        };
                        const fileName = `portfolio_BACKUP_${getLocalDate()}.json`;
                        const jsonStr = JSON.stringify(obj, null, 2);
                        const metadata = { name: fileName, mimeType: 'application/json' };
                        const form = new FormData();
                        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
                        form.append('file', new Blob([jsonStr], { type: 'application/json' }));
                        const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                            method: 'POST',
                            headers: { Authorization: `Bearer ${accessToken}` },
                            body: form
                        });
                        if (!res.ok) throw new Error(`Drive 上傳失敗：${res.status}`);
                        alert(`✅ 備份成功！\n檔案「${fileName}」已儲存至您的 Google 雲端硬碟。`);
                    } catch (err) {
                        console.error('[Drive Backup]', err);
                        alert('備份失敗：' + err.message);
                    } finally {
                        driveLoading.value = false;
                    }
                };

                // v3.9.0: 從 Google Drive 匯入（用 Picker 選檔）
                const importFromDrive = async () => {
                    if (!user.value || driveLoading.value) return;
                    driveLoading.value = true;
                    try {
                        const accessToken = await getDriveAccessToken();
                        await loadGapi();
                        await new Promise((resolve, reject) => {
                            const picker = new google.picker.PickerBuilder()
                                .setOAuthToken(accessToken)
                                .setDeveloperKey(PICKER_API_KEY)
                                .addView(
                                    new google.picker.DocsView()
                                        .setMimeTypes('application/json')
                                        .setQuery('portfolio_BACKUP')
                                )
                                .setTitle('選取備份檔案')
                                .setCallback(async (data) => {
                                    if (data.action === google.picker.Action.CANCEL) {
                                        driveLoading.value = false;
                                        return resolve();
                                    }
                                    if (data.action !== google.picker.Action.PICKED) return;
                                    try {
                                        const fileId = data.docs[0].id;
                                        const res = await fetch(
                                            `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
                                            { headers: { Authorization: `Bearer ${accessToken}` } }
                                        );
                                        if (!res.ok) throw new Error(`下載失敗：${res.status}`);
                                        const json = await res.json();
                                        if (!confirm(`警告：這將使用備份檔案中的資料更新您的資產紀錄。\n\n若 ID 相同將覆蓋舊資料，ID 不同則新增。\n\n確定要執行還原嗎？`)) {
                                            driveLoading.value = false;
                                            return resolve();
                                        }
                                        loadingTarget.value = 'import';
                                        const uid = user.value.uid;
                                        const batchLimit = 400;
                                        const restoreCol = async (colName, dataArr) => {
                                            if (!dataArr || !Array.isArray(dataArr)) return;
                                            const chunks = [];
                                            for (let i = 0; i < dataArr.length; i += batchLimit) chunks.push(dataArr.slice(i, i + batchLimit));
                                            for (const chunk of chunks) {
                                                const batch = db.batch();
                                                chunk.forEach(item => {
                                                    if (item.id) {
                                                        const { id, ...data } = item;
                                                        batch.set(db.collection('users').doc(uid).collection(colName).doc(id), data, { merge: true });
                                                    }
                                                });
                                                await batch.commit();
                                            }
                                        };
                                        await restoreCol('stocks', json.stocks);
                                        await restoreCol('transactions', json.transactions);
                                        await restoreCol('realized_gains', json.realized);
                                        await restoreCol('dividends', json.dividends);
                                        await restoreCol('notes', json.notes);
                                        await restoreCol('loans', json.loans);
                                        await restoreCol('real_estate', json.real_estate);
                                        if (json.history && Array.isArray(json.history)) {
                                            const chunks = [];
                                            for (let i = 0; i < json.history.length; i += batchLimit) chunks.push(json.history.slice(i, i + batchLimit));
                                            for (const chunk of chunks) {
                                                const batch = db.batch();
                                                chunk.forEach(h => { if (h.date) batch.set(db.collection('users').doc(uid).collection('history').doc(h.date), h, { merge: true }); });
                                                await batch.commit();
                                            }
                                        }
                                        if (json.cash) await db.collection('users').doc(uid).collection('portfolio').doc('cash').set(json.cash, { merge: true });
                                        alert('還原成功！頁面將重新整理。');
                                        location.reload();
                                    } catch (e) {
                                        console.error('[Drive Import]', e);
                                        alert('還原失敗：' + e.message);
                                        loadingTarget.value = null;
                                        driveLoading.value = false;
                                    }
                                    resolve();
                                })
                                .build();
                            picker.setVisible(true);
                        });
                    } catch (err) {
                        console.error('[Drive Import]', err);
                        alert('Drive 匯入失敗：' + err.message);
                        driveLoading.value = false;
                    }
                };

                const exportData = async () => { if (!user.value) return; const uid = user.value.uid; const allStocks = await db.collection('users').doc(uid).collection('stocks').get(); const allTrans = await db.collection('users').doc(uid).collection('transactions').get(); const allRealized = await db.collection('users').doc(uid).collection('realized_gains').get(); const allDividends = await db.collection('users').doc(uid).collection('dividends').get(); const allHistory = await db.collection('users').doc(uid).collection('history').orderBy('date').get(); const allNotes = await db.collection('users').doc(uid).collection('notes').get(); const allLoans = await db.collection('users').doc(uid).collection('loans').get(); const allRealEstate = await db.collection('users').doc(uid).collection('real_estate').get(); const cashDoc = await db.collection('users').doc(uid).collection('portfolio').doc('cash').get(); const obj = { stocks: allStocks.docs.map(d => ({ id: d.id, ...d.data() })), transactions: allTrans.docs.map(d => ({ id: d.id, ...d.data() })), realized: allRealized.docs.map(d => ({ id: d.id, ...d.data() })), dividends: allDividends.docs.map(d => ({ id: d.id, ...d.data() })), history: allHistory.docs.map(d => d.data()), cash: cashDoc.exists ? cashDoc.data() : { twd: 0, usd: 0, loan: 0 }, notes: allNotes.docs.map(d => ({ id: d.id, ...d.data() })), loans: allLoans.docs.map(d => ({ id: d.id, ...d.data() })), real_estate: allRealEstate.docs.map(d => ({ id: d.id, ...d.data() })) }; const a = document.createElement('a'); a.href = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(obj, null, 2)); a.download = `portfolio_FULL_BACKUP_${getLocalDate()}.json`; document.body.appendChild(a); a.click(); a.remove(); };

                const exportSimplifiedPortfolio = () => {
                    if (!user.value) return;
                    if (typeof XLSX === 'undefined') {
                        alert('Excel 元件載入失敗，請檢查網路連線。');
                        return;
                    }
                    const twHoldings = twStockList.value.filter(s => s.shares > 0);
                    const usHoldings = usStockList.value.filter(s => s.shares > 0);
                    const maxLen = Math.max(twHoldings.length, usHoldings.length);
                    const data = [['台股代號', '股數', '美股代號', '股數']];
                    for (let i = 0; i < maxLen; i++) {
                        const tw = twHoldings[i] || {};
                        const us = usHoldings[i] || {};
                        data.push([
                            tw.symbol || '',
                            tw.shares !== undefined && tw.shares !== null ? tw.shares : '',
                            us.symbol || '',
                            us.shares !== undefined && us.shares !== null ? us.shares : ''
                        ]);
                    }
                    const wb = XLSX.utils.book_new();
                    const ws = XLSX.utils.aoa_to_sheet(data);
                    XLSX.utils.book_append_sheet(wb, ws, "持股清單 Portfolio");
                    XLSX.writeFile(wb, `Portfolio_Simplified_${getLocalDate()}.xlsx`);
                };

                const exportToExcel = async () => { if (!user.value) return; if (typeof XLSX === 'undefined') { alert('Excel 元件載入失敗，請檢查網路連線。'); return; } const uid = user.value.uid; const wb = XLSX.utils.book_new(); const summaryData = [['項目', '金額 (TWD)', '金額 (USD)'], ['總淨資產 (Net Worth)', grandTotalValue.value, grandTotalValue.value / exchangeRate.value], ['台股部位', twStats.value.value, twStats.value.value / exchangeRate.value], ['美股部位', usStats.value.value * exchangeRate.value, usStats.value.value], ['台幣現金', cashData.value.twd, cashData.value.twd / exchangeRate.value], ['美金現金', cashData.value.usd * exchangeRate.value, cashData.value.usd], ['總負債 (Loans)', totalLoanBalance.value, totalLoanBalance.value / exchangeRate.value], ['未實現損益', grandTotalPnL.value, grandTotalPnL.value / exchangeRate.value], ['匯率 (USD/TWD)', exchangeRate.value, '']]; XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryData), "總覽 Summary"); const sSnap = await db.collection('users').doc(uid).collection('stocks').get(); const stockData = sSnap.docs.map(d => d.data()).map(s => ({ 代號: s.symbol, 名稱: s.name, 幣別: s.currency, 股數: s.shares, 平均成本: s.avgCost, 現價: s.currentPrice, 市值: s.shares * s.currentPrice, 損益: (s.currentPrice - s.avgCost) * s.shares })); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stockData), "庫存 Stocks"); const tSnap = await db.collection('users').doc(uid).collection('transactions').orderBy('date', 'desc').get(); const txData = tSnap.docs.map(d => d.data()); const wsTrans = XLSX.utils.json_to_sheet(txData.map(t => ({ 日期: t.date, 類別: getTypeName(t.type), 代號: t.symbol, 名稱: t.name, 股數: t.shares, 總金額: t.totalAmount, 幣別: t.currency, 備註: t.memo || '' }))); XLSX.utils.book_append_sheet(wb, wsTrans, "交易紀錄 Transactions"); const hSnap = await db.collection('users').doc(uid).collection('history').orderBy('date', 'desc').get(); const histData = hSnap.docs.map(d => d.data()); const wsHist = XLSX.utils.json_to_sheet(histData.map(h => ({ 日期: h.date, 淨資產: h.totalVal, 總資產: (h.totalVal || 0) + (h.loan || 0), 負債: h.loan, 台股: h.twVal, 美股USD: h.usVal, 台幣現金: h.twCash || 0, 美金現金: h.usCash || 0 }))); XLSX.utils.book_append_sheet(wb, wsHist, "歷史淨值 History"); const rSnap = await db.collection('users').doc(uid).collection('realized_gains').orderBy('date', 'desc').get(); const realData = rSnap.docs.map(d => d.data()); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(realData), "已實現損益 Realized"); const dSnap = await db.collection('users').doc(uid).collection('dividends').orderBy('date', 'desc').get(); const divData = dSnap.docs.map(d => d.data()); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(divData), "股息 Dividends"); const lSnap = await db.collection('users').doc(uid).collection('loans').get(); const loanData = lSnap.docs.map(d => d.data()); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(loanData), "借款 Loans"); const nSnap = await db.collection('users').doc(uid).collection('notes').get(); const noteData = nSnap.docs.map(d => d.data()); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(noteData), "筆記 Notes"); const reSnap = await db.collection('users').doc(uid).collection('real_estate').get(); const reData = reSnap.docs.map(d => d.data()); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(reData), "不動產 RealEstate"); XLSX.writeFile(wb, `Portfolio_FULL_Export_${getLocalDate()}.xlsx`); };

                const triggerImport = () => { fileInput.value.click(); };

                const handleImport = async (event) => { const file = event.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = async (e) => { try { const json = JSON.parse(e.target.result); if (!confirm(`警告：這將使用備份檔案中的資料更新您的資產紀錄。\n\n若 ID 相同將覆蓋舊資料，ID 不同則新增。\n\n確定要執行還原嗎？`)) { event.target.value = ''; return; } loadingTarget.value = 'import'; const uid = user.value.uid; const batchLimit = 400; const restoreCollection = async (colName, dataArr) => { if (!dataArr || !Array.isArray(dataArr)) return; const chunks = []; for (let i = 0; i < dataArr.length; i += batchLimit) { chunks.push(dataArr.slice(i, i + batchLimit)); } for (const chunk of chunks) { const batch = db.batch(); chunk.forEach(item => { if (item.id) { const docRef = db.collection('users').doc(uid).collection(colName).doc(item.id); const { id, ...data } = item; batch.set(docRef, data, { merge: true }); } }); await batch.commit(); } }; await restoreCollection('stocks', json.stocks); await restoreCollection('transactions', json.transactions); await restoreCollection('realized_gains', json.realized); await restoreCollection('dividends', json.dividends); await restoreCollection('notes', json.notes); await restoreCollection('loans', json.loans); await restoreCollection('real_estate', json.real_estate); if (json.history && Array.isArray(json.history)) { const chunks = []; for (let i = 0; i < json.history.length; i += batchLimit) { chunks.push(json.history.slice(i, i + batchLimit)); } for (const chunk of chunks) { const batch = db.batch(); chunk.forEach(h => { if (h.date) { const docRef = db.collection('users').doc(uid).collection('history').doc(h.date); batch.set(docRef, h, { merge: true }); } }); await batch.commit(); } } if (json.cash) { await db.collection('users').doc(uid).collection('portfolio').doc('cash').set(json.cash, { merge: true }); } alert('還原成功！頁面將重新整理。'); location.reload(); } catch (err) { console.error(err); alert('還原失敗：檔案格式錯誤或網路問題。'); loadingTarget.value = null; } }; reader.readAsText(file); };

                const clearAllUserData = async () => {
                    if (!user.value) return;
                    if (!confirm('⚠️ 嚴重警告\n\n您確定要「永久刪除」此帳號下的所有資產資料嗎？\n\n此操作將清空：\n- 所有庫存與交易紀錄\n- 歷史淨值與股息\n- 筆記與借款設定\n\n資料一旦刪除將「無法復原」！')) return;
                    const input = prompt('請輸入 "DELETE" (全大寫) 以確認刪除操作：');
                    if (input !== 'DELETE') return alert('驗證碼錯誤，已取消刪除。');
                    isLoading.value = true;
                    const uid = user.value.uid;
                    const collections = ['stocks', 'transactions', 'realized_gains', 'dividends', 'history', 'notes', 'loans'];
                    try {
                        for (const colName of collections) {
                            const snapshot = await db.collection('users').doc(uid).collection(colName).get();
                            if (snapshot.empty) continue;
                            const batchLimit = 400;
                            const chunks = [];
                            const docs = snapshot.docs;
                            for (let i = 0; i < docs.length; i += batchLimit) { chunks.push(docs.slice(i, i + batchLimit)); }
                            for (const chunk of chunks) { const batch = db.batch(); chunk.forEach(doc => batch.delete(doc.ref)); await batch.commit(); }
                        }
                        await db.collection('users').doc(uid).collection('portfolio').doc('cash').delete();
                        alert('所有資料已成功清除，系統將自動登出。');
                        logout();
                    } catch (err) { console.error(err); alert('刪除失敗，請稍後再試：' + err.message); } finally { isLoading.value = false; }
                };

                const fetchRealizedGains = async () => { if (!user.value) return; sectionLoading.value = true; try { const snap = await db.collection('users').doc(user.value.uid).collection('realized_gains').where('date', '>=', realizedStartDate.value).where('date', '<=', realizedEndDate.value).orderBy('date', 'desc').get(); realizedGains.value = snap.docs.map(d => ({ id: d.id, ...d.data() })); } finally { sectionLoading.value = false; } };
                const fetchDividends = async () => { if (!user.value) return; sectionLoading.value = true; try { const snap = await db.collection('users').doc(user.value.uid).collection('dividends').where('date', '>=', divStartDate.value).where('date', '<=', divEndDate.value).orderBy('date', 'desc').get(); dividendRecords.value = snap.docs.map(d => ({ id: d.id, ...d.data() })); } finally { sectionLoading.value = false; } };
                const fetchTransactions = async () => {
                    if (!user.value) return;
                    sectionLoading.value = true;
                    try {
                        const snap = await db.collection('users').doc(user.value.uid).collection('transactions').where('date', '>=', transStartDate.value).where('date', '<=', transEndDate.value).orderBy('date', 'desc').get();
                        transactionHistory.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                    } finally {
                        sectionLoading.value = false;
                    }

                };

                const openHistoryModal = async () => { 
                    if (!user.value) return; 
                    showHistoryModal.value = true;
                    try {
                        const start = `${historyFilterYear.value}-01-01`; 
                        const end = `${historyFilterYear.value}-12-31`; 
                        const snap = await db.collection('users').doc(user.value.uid).collection('history').where('date', '>=', start).where('date', '<=', end).orderBy('date', 'desc').get(); 
                        historyRecords.value = snap.docs.map(d => ({ id: d.id, ...d.data() })); 
                    } catch(err) {
                        console.error('History fetch error:', err);
                        alert('載入歷史資料失敗：' + err.message);
                    }
                };
                const deleteHistoryRecord = async (date) => { if (!confirm(`確定要刪除 ${date} 的歷史紀錄嗎？`)) return; await db.collection('users').doc(user.value.uid).collection('history').doc(date).delete(); await openHistoryModal(); drawChart(); };
                const openHistoryEditModal = (rec) => { historyEditForm.value = { date: rec.date, twVal: rec.twVal || 0, usVal: rec.usVal || 0, twCash: rec.twCash || 0, usCash: rec.usCash || 0, loan: rec.loan || 0, realestate: rec.realestate || rec.realEstateVal || 0 }; showHistoryEditModalVisible.value = true; };
                const calculateHistoryNetWorth = () => { const asset = (historyEditForm.value.twVal || 0) + (historyEditForm.value.twCash || 0) + ((historyEditForm.value.usVal || 0) + (historyEditForm.value.usCash || 0)) * exchangeRate.value + (historyEditForm.value.realestate || 0); const loan = historyEditForm.value.loan || 0; return asset - loan; };
                const saveHistoryRecord = async () => { if (!user.value) return; const newNetWorth = calculateHistoryNetWorth(); await db.collection('users').doc(user.value.uid).collection('history').doc(historyEditForm.value.date).update({ twVal: historyEditForm.value.twVal, usVal: historyEditForm.value.usVal, twCash: historyEditForm.value.twCash, usCash: historyEditForm.value.usCash, loan: historyEditForm.value.loan, realestate: historyEditForm.value.realestate, totalVal: newNetWorth }); showHistoryEditModalVisible.value = false; await openHistoryModal(); drawChart(); };
                const openLoanMgrModal = () => { showLoanMgrModal.value = true; loanForm.value = { id: null, name: '', balance: 0, type: 'other', isInvestmentUse: false, monthlyPayment: 0, note: '' }; };
                const editLoanAccount = (l) => { loanForm.value = { type: 'other', isInvestmentUse: false, monthlyPayment: 0, note: '', ...l }; };
                const saveLoanAccount = async () => { if (!user.value || !loanForm.value.name) return alert('請輸入名稱'); const data = { name: loanForm.value.name, balance: loanForm.value.balance || 0, currency: 'TWD', type: loanForm.value.type || 'other', isInvestmentUse: !!loanForm.value.isInvestmentUse, monthlyPayment: loanForm.value.monthlyPayment || 0, note: loanForm.value.note || '' }; if (loanForm.value.id) await db.collection('users').doc(user.value.uid).collection('loans').doc(loanForm.value.id).update(data); else await db.collection('users').doc(user.value.uid).collection('loans').add(data); loanForm.value = { id: null, name: '', balance: 0, type: 'other', isInvestmentUse: false, monthlyPayment: 0, note: '' }; };
                const deleteLoanAccount = async (l) => { if (!confirm(`確定刪除 ${l.name}？(這不會影響已發生的交易紀錄)`)) return; await db.collection('users').doc(user.value.uid).collection('loans').doc(l.id).delete(); };
                // Inline 新增帳戶（從到 Modal 內創建，建完自動選中）
                const saveInlineLoanAccount = async () => {
                    if (!user.value || !inlineLoanName.value) return;
                    const data = { name: inlineLoanName.value.trim(), balance: 0, currency: 'TWD', type: 'other', isInvestmentUse: false };
                    const docRef = await db.collection('users').doc(user.value.uid).collection('loans').add(data);
                    // 建完自動選中此帳戶
                    transForm.value.loanId = docRef.id;
                    inlineLoanName.value = '';
                    inlineNewLoan.value = false;
                };
                const openNoteModal = (note) => { if (note) { noteForm.value = { ...note }; } else { noteForm.value = { id: null, title: '', date: getLocalDate(), content: '' }; } showNoteModalVisible.value = true; };
                const closeNoteModal = () => showNoteModalVisible.value = false;
                const saveNote = async () => { if (!user.value || !noteForm.value.title) return alert('請輸入標題'); const data = { title: noteForm.value.title, date: noteForm.value.date || getLocalDate(), content: noteForm.value.content || '', timestamp: firebase.firestore.FieldValue.serverTimestamp() }; if (noteForm.value.id) { await db.collection('users').doc(user.value.uid).collection('notes').doc(noteForm.value.id).update(data); } else { await db.collection('users').doc(user.value.uid).collection('notes').add(data); } closeNoteModal(); };
                const deleteNote = async (id) => { if (!confirm('確定刪除此筆記？')) return; await db.collection('users').doc(user.value.uid).collection('notes').doc(id).delete(); };
                // v3.6.0: 交易編輯（僅允許修改日期、備註等非金融欄位）
                const openEditTxModal = (tx) => {
                    editTxForm.value = { id: tx.id, date: tx.date, name: tx.name || '', memo: tx.memo || '' };
                    showEditTxModal.value = true;
                };
                const saveEditTx = async () => {
                    if (!user.value || !editTxForm.value.id) return;
                    await db.collection('users').doc(user.value.uid).collection('transactions').doc(editTxForm.value.id).update({
                        date: editTxForm.value.date,
                        name: editTxForm.value.name,
                        memo: editTxForm.value.memo,
                    });
                    showEditTxModal.value = false;
                    if (activeSection.value === 'transactions') fetchTransactions();
                };
                const deleteTransaction = (tx) => { pendingDeleteTx.value = tx; showDeleteModal.value = true; };

                const executeDelete = async (revertCash) => { showDeleteModal.value = false; const tx = pendingDeleteTx.value; if (!tx) return; if (revertCash) { if (tx.type === 'deposit') {
                        await updateCash(tx.currency, -Math.abs(tx.totalAmount), 0);
                        if (tx.symbol === 'CASH' && (tx.name.includes('期貨保證金') || (tx.memo && tx.memo.includes('期貨保證金')))) {
                            const marginRef = db.collection('users').doc(user.value.uid).collection('portfolio').doc('futures_margin');
                            const marginDoc = await marginRef.get();
                            if (marginDoc.exists) {
                                const marginData = marginDoc.data();
                                const key = tx.currency === 'USD' ? 'usd' : 'twd';
                                marginData[key] = (marginData[key] || 0) + Math.abs(tx.totalAmount);
                                await marginRef.set(marginData, { merge: true });
                            }
                        }
                    } else if (tx.type === 'withdraw') {
                        await updateCash(tx.currency, Math.abs(tx.totalAmount), 0);
                        if (tx.symbol === 'CASH' && (tx.name.includes('期貨保證金') || (tx.memo && tx.memo.includes('期貨保證金')))) {
                            const marginRef = db.collection('users').doc(user.value.uid).collection('portfolio').doc('futures_margin');
                            const marginDoc = await marginRef.get();
                            if (marginDoc.exists) {
                                const marginData = marginDoc.data();
                                const key = tx.currency === 'USD' ? 'usd' : 'twd';
                                marginData[key] = Math.max(0, (marginData[key] || 0) - Math.abs(tx.totalAmount));
                                await marginRef.set(marginData, { merge: true });
                            }
                        }
                    } else if (tx.type === 'borrow') { if (tx.loanId) await updateLoanBalance(tx.loanId, -Math.abs(tx.totalAmount)); else alert('此為舊版借款紀錄，請手動調整對應帳戶餘額。'); if (tx.cashSynced === true) await updateCash(tx.currency || 'TWD', -Math.abs(tx.totalAmount), 0); } else if (tx.type === 'repay') { if (tx.loanId) await updateLoanBalance(tx.loanId, Math.abs(tx.totalAmount)); if (tx.cashSynced === true) await updateCash(tx.currency || 'TWD', Math.abs(tx.totalAmount), 0); } else if (tx.type === 'dividend') { await updateCash(tx.currency, -Math.abs(tx.totalAmount), 0); const stock = stocks.value.find(s => s.symbol === tx.symbol); if (stock) { await db.collection('users').doc(user.value.uid).collection('stocks').doc(stock.id).update({ dividends: Math.max(0, (stock.dividends || 0) - tx.totalAmount) }); } } else if (tx.type === 'buy') { await updateCash(tx.currency, Math.abs(tx.totalAmount), 0); const stock = stocks.value.find(s => s.symbol === tx.symbol); if (stock) { const ns = stock.shares - tx.shares; if (ns <= 0) { await db.collection('users').doc(user.value.uid).collection('stocks').doc(stock.id).delete(); } else { const remainingValue = (stock.shares * stock.avgCost) - tx.totalAmount; const na = remainingValue > 0 ? remainingValue / ns : 0; await db.collection('users').doc(user.value.uid).collection('stocks').doc(stock.id).update({ shares: ns, avgCost: na }); } } } else if (tx.type === 'sell') { alert('系統提示：已將您的賣出金額從現金中扣除。但因系統無法追蹤原銷售股票之成本紀錄，請您手動至「已實現損益」與「庫存」調整對應股數與紀錄，以確保資料正確。'); await updateCash(tx.currency, -Math.abs(tx.totalAmount), 0); } } await db.collection('users').doc(user.value.uid).collection('transactions').doc(tx.id).delete(); fetchTransactions(); setTimeout(async () => { await saveDailySnapshot(); if (activeSection.value === 'transactions') fetchTransactions(); if (activeSection.value === 'realized') fetchRealizedGains(); if (activeSection.value === 'overview' || activeSection.value === '') drawChart(); }, 500); pendingDeleteTx.value = null; };
                const deleteDividend = async (rec) => { if (!confirm('刪除股息？(現金將自動扣回)')) return; const stock = stocks.value.find(s => s.symbol === rec.symbol); if (stock) { await db.collection('users').doc(user.value.uid).collection('stocks').doc(stock.id).update({ dividends: Math.max(0, (stock.dividends || 0) - rec.amount) }); } await updateCash(rec.currency, -rec.amount, 0); await db.collection('users').doc(user.value.uid).collection('dividends').doc(rec.id).delete(); fetchDividends(); setTimeout(async () => { await saveDailySnapshot(); if (activeSection.value === 'overview' || activeSection.value === '') drawChart(); }, 500); };
                const deleteRealized = async (id) => { if (!confirm('刪除？')) return; await db.collection('users').doc(user.value.uid).collection('realized_gains').doc(id).delete(); fetchRealizedGains(); };
                const saveDailySnapshot = async () => { if (!user.value) return; const todayStr = getLocalDate(); const historyRef = db.collection('users').doc(user.value.uid).collection('history').doc(todayStr); const currentHour = new Date().getHours(); const snapshot = { date: todayStr, timestamp: firebase.firestore.FieldValue.serverTimestamp(), savedHour: currentHour, totalVal: grandTotalValue.value, twVal: twStats.value.value, usVal: usStats.value.value, twCash: cashData.value.twd || 0, usCash: cashData.value.usd || 0, loan: totalLoanBalance.value, totalPnL: grandTotalPnL.value, twPnL: twStats.value.pnl, usPnL: usStats.value.pnl, realestate: realEstateTotalMarket.value, leverage: leverageRatio.value, exposure: exposureRatio.value, funds: mutualFundTotalValue.value, futures: futuresEquity.value }; if (currentHour >= 21) { const doc = await historyRef.get(); if (doc.exists) { const existingSavedHour = doc.data().savedHour; if (existingSavedHour !== undefined && existingSavedHour < 21 && doc.data().totalVal > 0) { return; } } } await historyRef.set(snapshot, { merge: true }); };

                const updateCash = async (currency, amount, loanAmount = 0) => {
                    if (!user.value) return;
                    const ref = db.collection('users').doc(user.value.uid).collection('portfolio').doc('cash');
                    await db.runTransaction(async (transaction) => {
                        const doc = await transaction.get(ref);
                        let current = doc.exists ? doc.data() : { twd: 0, usd: 0, loan: 0 };
                        let newTwd = current.twd || 0;
                        let newUsd = current.usd || 0;
                        if (currency === 'TWD') newTwd += amount;
                        else newUsd += amount;
                        if (!doc.exists) {
                            transaction.set(ref, { twd: newTwd, usd: newUsd, loan: 0 });
                        } else {
                            transaction.update(ref, { twd: newTwd, usd: newUsd });
                        }
                        // 樂觀更新本地狀態
                        cashData.value.twd = newTwd;
                        cashData.value.usd = newUsd;
                    });
                };
                const updateLoanBalance = async (loanId, amount) => { if (!user.value || !loanId) return; const ref = db.collection('users').doc(user.value.uid).collection('loans').doc(loanId); const doc = await ref.get(); if (doc.exists) { const newBal = (doc.data().balance || 0) + amount; await ref.update({ balance: newBal }); } };
                const fetchPreviousDayData = async (uid) => { const todayStr = getLocalDate(); const snap = await db.collection('users').doc(uid).collection('history').orderBy('date', 'desc').limit(2).get(); if (snap.empty) return; const docs = snap.docs.map(d => d.data()); if (docs[0].date !== todayStr) prevDayData.value = docs[0]; else if (docs.length > 1) prevDayData.value = docs[1]; };

                const drawChart = async () => {
                    if (!user.value || !document.getElementById('assetChart')) return;
                    const snap = await db.collection('users').doc(user.value.uid).collection('history')
                        .where('date', '>=', chartStartDate.value)
                        .where('date', '<=', chartEndDate.value)
                        .orderBy('date', 'asc').get();
                    const d = snap.docs.map(x => x.data());

                    // 計算期間損益
                    const calcNetWorth = x => {
                        if (x.totalVal !== undefined && x.totalVal > 0) return x.totalVal;
                        const asset = (x.twVal || 0) + (x.twCash || 0) + ((x.usVal || 0) + (x.usCash || 0)) * exchangeRate.value + (x.realestate || 0) + (x.futures || 0) + (x.funds || 0);
                        return asset - (x.loan || 0);
                    };
                    if (d.length >= 2) {
                        const startVal = calcNetWorth(d[0]);
                        const endVal = calcNetWorth(d[d.length - 1]);
                        const amount = endVal - startVal;
                        const pct = startVal !== 0 ? (amount / Math.abs(startVal)) * 100 : 0;
                        chartPnl.value = { amount, pct, startVal, endVal };
                    } else if (d.length === 1) {
                        chartPnl.value = { amount: 0, pct: 0, startVal: calcNetWorth(d[0]), endVal: calcNetWorth(d[0]) };
                    } else {
                        chartPnl.value = { amount: null, pct: null, startVal: null, endVal: null };
                    }

                    if (chartInstance) chartInstance.destroy();
                    const isDark = document.documentElement.classList.contains('dark');
                    const totalColor = isDark ? '#a78bfa' : '#1f2937';
                    const gridColor = isDark ? '#374151' : '#e5e7eb';
                    // v4.4.0: 計算歷史槓桿比（有存 leverage 欄位用它，否則從 totalVal + loan 推算）
                    const calcLeverage = x => {
                        if (x.leverage !== undefined) return x.leverage;
                        const netWorth = calcNetWorth(x);
                        if (netWorth <= 0) return 1;
                        const gross = netWorth + (x.loan || 0);
                        return gross / netWorth;
                    };
                    const hasLoan = d.some(x => (x.loan || 0) > 0 || (x.leverage !== undefined && x.leverage > 1.01));

                    chartInstance = new Chart(document.getElementById('assetChart').getContext('2d'), {
                        type: 'line',
                        data: {
                            labels: d.map(x => x.date),
                            datasets: [
                                { label: '淨資產 (Net Worth)', data: d.map(calcNetWorth), borderColor: totalColor, fill: true, backgroundColor: isDark ? 'rgba(167, 139, 250, 0.1)' : 'rgba(31,41,55,0.1)', tension: 0.3, yAxisID: 'y' },
                                { label: '台股 (Stock)', data: d.map(x => x.twVal), borderColor: '#3b82f6', hidden: true, tension: 0.3, yAxisID: 'y' },
                                { label: '美股 (Stock TWD)', data: d.map(x => x.usVal * exchangeRate.value), borderColor: '#ef4444', hidden: true, tension: 0.3, yAxisID: 'y' },
                                { label: '台股帳戶 (Stock+Cash)', data: d.map(x => (x.twVal || 0) + (x.twCash || 0)), borderColor: '#93c5fd', borderDash: [5, 5], hidden: true, tension: 0.3, yAxisID: 'y' },
                                { label: '美股帳戶 (Stock+Cash)', data: d.map(x => ((x.usVal || 0) + (x.usCash || 0)) * exchangeRate.value), borderColor: '#fca5a5', borderDash: [5, 5], hidden: true, tension: 0.3, yAxisID: 'y' },
                                // v4.4.0: 槓桿比（副 Y 軸，右側）
                                { label: '槓桿比 (Leverage)', data: hasLoan ? d.map(calcLeverage) : [], borderColor: '#f59e0b', borderDash: [3, 3], borderWidth: 1.5, pointRadius: 2, tension: 0.3, yAxisID: 'yLeverage', hidden: !hasLoan }
                            ]
                        },
                        options: {
                            responsive: true, maintainAspectRatio: false,
                            scales: {
                                y: { ticks: { callback: v => 'NT$' + (v / 10000).toFixed(0) + '萬', color: isDark ? '#9ca3af' : '#666' }, grid: { color: gridColor } },
                                x: { ticks: { color: isDark ? '#9ca3af' : '#666' }, grid: { color: gridColor } },
                                yLeverage: {
                                    position: 'right',
                                    display: hasLoan,
                                    min: 1,
                                    ticks: { callback: v => v.toFixed(2) + 'x', color: '#f59e0b' },
                                    grid: { drawOnChartArea: false }
                                }
                            },
                            plugins: { legend: { labels: { color: isDark ? '#e5e7eb' : '#666' } } }
                        }
                    });
                };
                // v4.9.0: 單環圓餅，各持股 + 現金各一片，分母 = 股票現值 + 同幣別現金
                const drawPieCharts = () => {
                    if (pieTwInstance) pieTwInstance.destroy();
                    if (pieUsInstance) pieUsInstance.destroy();

                    const isDark = isDarkMode.value;
                    const cashTwd = cashData.value.twd || 0;
                    const cashUsd = cashData.value.usd || 0;

                    const twColors = ['#3b82f6','#2563eb','#1d4ed8','#60a5fa','#93c5fd','#1e40af','#0ea5e9','#0284c7','#0369a1','#bfdbfe'];
                    const usColors = ['#ef4444','#dc2626','#b91c1c','#f87171','#fca5a5','#991b1b','#f97316','#ea580c','#c2410c','#fee2e2'];
                    const cashColor = '#9ca3af';

                    const makeTooltip = (currency) => ({
                        callbacks: {
                            label: function(c) {
                                const l = c.label || '';
                                const v = c.raw;
                                const total = c.chart._metasets[c.datasetIndex].total;
                                const p = total > 0 ? ((v / total) * 100).toFixed(1) + '%' : '0%';
                                return `${l}: ${formatCurrency(v, currency)} (${p})`;
                            }
                        }
                    });

                    if (document.getElementById('pieTw') && (twStockList.value.length || cashTwd > 0)) {
                        const labels = [...twStockList.value.map(s => s.name || s.symbol)];
                        const data   = [...twStockList.value.map(s => s.currentPrice * s.shares)];
                        const colors = [...twStockList.value.map((_, i) => twColors[i % twColors.length])];
                        if (cashTwd > 0) { labels.push('現金 (TWD)'); data.push(cashTwd); colors.push(cashColor); }
                        pieTwInstance = new Chart(document.getElementById('pieTw'), {
                            type: 'doughnut',
                            data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, hoverOffset: 8 }] },
                            options: {
                                responsive: true, maintainAspectRatio: false,
                                plugins: { tooltip: makeTooltip('TWD'), legend: { display: false } }
                            }
                        });
                    }

                    if (document.getElementById('pieUs') && (usStockList.value.length || cashUsd > 0)) {
                        const labels = [...usStockList.value.map(s => s.name || s.symbol)];
                        const data   = [...usStockList.value.map(s => s.currentPrice * s.shares)];
                        const colors = [...usStockList.value.map((_, i) => usColors[i % usColors.length])];
                        if (cashUsd > 0) { labels.push('現金 (USD)'); data.push(cashUsd); colors.push(cashColor); }
                        pieUsInstance = new Chart(document.getElementById('pieUs'), {
                            type: 'doughnut',
                            data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, hoverOffset: 8 }] },
                            options: {
                                responsive: true, maintainAspectRatio: false,
                                plugins: { tooltip: makeTooltip('USD'), legend: { display: false } }
                            }
                        });
                    }
                };

                const calculateNewAvg = () => { if (transForm.value.type !== 'buy' || !transForm.value.shares || !transForm.value.totalAmount) return transForm.value.currentAvg; const old = transForm.value.currentShares * transForm.value.currentAvg; return (old + transForm.value.totalAmount) / (transForm.value.currentShares + transForm.value.shares); };
                const openTransModal = (s, type = 'buy') => { if (s) { transForm.value = { id: s.id, type: 'buy', symbol: s.symbol, name: s.name, shares: '', totalAmount: '', currentShares: s.shares, currentAvg: s.avgCost, date: getLocalDate(), memo: '' }; form.value.currency = s.currency; } else { transForm.value = { id: null, type: type, symbol: '', name: '', shares: '', totalAmount: '', currentShares: 0, currentAvg: 0, date: getLocalDate(), memo: '' }; form.value.currency = 'TWD'; } isFundMode.value = false; isLoanMode.value = false; showTransModal.value = true; };
                const openFundModal = () => { isFundMode.value = true; isLoanMode.value = false; transForm.value = { id: null, type: 'deposit', symbol: 'CASH', name: '', shares: 0, totalAmount: '', date: getLocalDate(), memo: '' }; form.value.currency = 'TWD'; showTransModal.value = true; };
                const openLoanModal = () => { isLoanMode.value = true; isFundMode.value = false; loanCashMode.value = 'sync'; inlineNewLoan.value = false; inlineLoanName.value = ''; transForm.value = { id: null, type: 'borrow', symbol: 'LOAN', name: '', shares: 0, totalAmount: '', date: getLocalDate(), loanId: '', memo: '' }; form.value.currency = 'TWD'; showTransModal.value = true; };
                const closeTransModal = () => showTransModal.value = false;

                const submitTransaction = async () => {
                    const selectedLoan = isLoanMode.value ? loanList.value.find(l => l.id === transForm.value.loanId) : null;
                    const loanName = selectedLoan ? selectedLoan.name : '';
                    // v3.0.0 Update: Append memo to loan name if present
                    const nameStr = isLoanMode.value
                        ? `${getTypeName(transForm.value.type)} (${loanName})${transForm.value.name ? ' - ' + transForm.value.name : ''}`
                        : (isFundMode.value ? (transForm.value.name || getTypeName(transForm.value.type)) : transForm.value.name);

                    const logData = {
                        date: transForm.value.date || getLocalDate(),
                        type: transForm.value.type,
                        symbol: (isFundMode.value) ? 'CASH' : (isLoanMode.value ? 'LOAN' : transForm.value.symbol.toUpperCase()),
                        name: nameStr,
                        shares: (isFundMode.value || isLoanMode.value || transForm.value.type === 'dividend') ? 0 : transForm.value.shares,
                        price: 0,
                        totalAmount: transForm.value.totalAmount,
                        currency: form.value.currency,
                        loanId: isLoanMode.value ? transForm.value.loanId : null,
                        cashSynced: isLoanMode.value ? (loanCashMode.value === 'sync') : null, // v3.7.4: 記錄是否有同步現金
                        memo: transForm.value.memo || '', // v4.0.5 Fix: Prevent overwriting with stock name
                        timestamp: firebase.firestore.FieldValue.serverTimestamp()
                    };

                    if (isLoanMode.value) {
                        if (!transForm.value.totalAmount) return alert('請輸入金額');
                        if (!transForm.value.loanId) return alert('請選擇借款帳戶');

                        // v3.7.3: 簡化邏輯，直接依 loanCashMode 決定是否動現金
                        const shouldSyncCash = loanCashMode.value === 'sync';
                        let cashDelta = 0;
                        let loanDelta = 0;

                        if (transForm.value.type === 'borrow') {
                            loanDelta = transForm.value.totalAmount;
                            if (shouldSyncCash) cashDelta = transForm.value.totalAmount;
                        } else {
                            // 還款 (Repay)
                            loanDelta = -transForm.value.totalAmount;
                            if (shouldSyncCash) cashDelta = -transForm.value.totalAmount;
                        }

                        await updateLoanBalance(transForm.value.loanId, loanDelta);
                        if (cashDelta !== 0) await updateCash(form.value.currency, cashDelta, 0);

                        await db.collection('users').doc(user.value.uid).collection('transactions').add(logData);
                        closeTransModal();
                        setTimeout(async () => { await saveDailySnapshot(); if (activeSection.value === 'overview' || activeSection.value === '') drawChart(); }, 500);
                        return;
                    }
                    if (isFundMode.value) { if (!transForm.value.totalAmount) return alert('請輸入金額'); const amount = transForm.value.type === 'deposit' ? transForm.value.totalAmount : -transForm.value.totalAmount; await updateCash(form.value.currency, amount, 0); await db.collection('users').doc(user.value.uid).collection('transactions').add(logData); closeTransModal(); setTimeout(async () => { await saveDailySnapshot(); if (activeSection.value === 'overview' || activeSection.value === '') drawChart(); }, 500); return; } if (transForm.value.type === 'dividend') { if (!transForm.value.totalAmount) return alert('請輸入金額'); const dividendData = { ...logData, amount: transForm.value.totalAmount }; await db.collection('users').doc(user.value.uid).collection('dividends').add(dividendData); await db.collection('users').doc(user.value.uid).collection('transactions').add(logData); await updateCash(form.value.currency, transForm.value.totalAmount, 0); const existingStock = stocks.value.find(s => s.symbol === transForm.value.symbol); if (existingStock) { await db.collection('users').doc(user.value.uid).collection('stocks').doc(existingStock.id).update({ dividends: (existingStock.dividends || 0) + transForm.value.totalAmount }); } closeTransModal(); setTimeout(async () => { await saveDailySnapshot(); if (activeSection.value === 'overview' || activeSection.value === '') drawChart(); }, 500); return; } if (!transForm.value.shares || !transForm.value.totalAmount) return alert('請輸入完整資訊'); logData.price = transForm.value.totalAmount / transForm.value.shares; let stockId = transForm.value.id; let currentShares = transForm.value.currentShares; let currentAvg = transForm.value.currentAvg; if (!stockId) { const existing = stocks.value.find(s => s.symbol === transForm.value.symbol); if (existing) { stockId = existing.id; currentShares = existing.shares; currentAvg = existing.avgCost; } else if (transForm.value.type === 'buy') { const newDoc = await db.collection('users').doc(user.value.uid).collection('stocks').add({ symbol: transForm.value.symbol, name: transForm.value.name, currency: form.value.currency, marketType: form.value.currency === 'USD' ? 'us' : '', shares: 0, avgCost: 0, currentPrice: 0, dividends: 0 }); stockId = newDoc.id; } else { const pnl = transForm.value.totalAmount - 0; await db.collection('users').doc(user.value.uid).collection('realized_gains').add({ ...logData, pnl: pnl, price: logData.price }); await db.collection('users').doc(user.value.uid).collection('transactions').add(logData); await updateCash(form.value.currency, transForm.value.totalAmount, 0); closeTransModal(); return; } } let ns = 0, na = 0; if (transForm.value.type === 'buy') { ns = currentShares + transForm.value.shares; const oldTotal = currentShares * currentAvg; na = (oldTotal + transForm.value.totalAmount) / ns; await updateCash(form.value.currency, -transForm.value.totalAmount, 0); } else { if (transForm.value.shares > currentShares) return alert('股數不足'); ns = currentShares - transForm.value.shares; na = currentAvg; const pnl = transForm.value.totalAmount - (transForm.value.shares * currentAvg); await db.collection('users').doc(user.value.uid).collection('realized_gains').add({ ...logData, pnl: pnl, price: logData.price }); await updateCash(form.value.currency, transForm.value.totalAmount, 0); } await db.collection('users').doc(user.value.uid).collection('transactions').add(logData); if (stockId) { const ref = db.collection('users').doc(user.value.uid).collection('stocks').doc(stockId); await ref.update({ shares: ns, avgCost: na }); if (ns === 0 && confirm('股數歸零，是否刪除此庫存項目？')) await ref.delete(); } setTimeout(async () => { await saveDailySnapshot(); if (activeSection.value === 'transactions') fetchTransactions(); if (activeSection.value === 'overview' || activeSection.value === '') drawChart(); }, 500); closeTransModal();
                };

                const openModal = () => { isEditing.value = false; form.value = { id: Date.now().toString(), symbol: '', name: '', currency: 'TWD', marketType: '', shares: 0, avgCost: 0, totalCostInput: 0, currentPrice: 0, dividends: 0, previousClose: 0, multiplier: 1, isETF: false }; showModal.value = true; };
                const editStock = (s) => { isEditing.value = true; form.value = { ...s, totalCostInput: parseFloat((s.shares * s.avgCost).toFixed(2)), multiplier: s.multiplier || 1, isETF: s.isETF || false }; showModal.value = true; };
                const closeModal = () => showModal.value = false;
                const saveStock = async () => { if (!user.value || !form.value.symbol) return; const d = { ...form.value }; if (form.value.shares > 0 && form.value.totalCostInput > 0) { d.avgCost = form.value.totalCostInput / form.value.shares; } delete d.totalCostInput; const r = db.collection('users').doc(user.value.uid).collection('stocks'); if (isEditing.value) await r.doc(d.id).update(d); else await r.doc(d.id).set(d); closeModal(); };

                // v4.5.0: 自動偵測槓桿倍數
                const autoDetectMultiplier = (name, symbol) => {
                    const n = (name || '').toUpperCase();
                    const s = (symbol || '').toUpperCase();
                    if (n.includes('正2') || n.includes('2X') || s.endsWith('L')) return 2;
                    if (n.includes('反1') || n.includes('INVERSE') || s.endsWith('R')) return -1; // 反向也可以考慮，但通常曝險算絕對值或負向
                    return 1;
                };

                watch(() => form.value.name, (newVal) => {
                    if (!isEditing.value && newVal) {
                        form.value.multiplier = autoDetectMultiplier(newVal, form.value.symbol);
                    }
                });

                const deleteStock = async (stock) => {
                    if (!user.value) return;
                    if (!confirm(`⚠️ 刪除警告\n\n您確定要刪除「${stock.name} (${stock.symbol})」的庫存資料嗎？\n\n請注意：\n1. 這只是「刪除資料」，並非賣出股票。\n2. 此操作不會產生交易紀錄，也不會變動現金餘額。\n3. 若您實際上已賣出，請按「取消」，並使用「補登 > 賣出」功能。`)) return;
                    await db.collection('users').doc(user.value.uid).collection('stocks').doc(stock.id).delete();
                };

                const openStockNoteModal = (stock) => {
                    stockNoteForm.value = {
                        id: stock.id,
                        symbol: stock.symbol,
                        name: stock.name,
                        content: stock.note || ''
                    };
                    showStockNoteModal.value = true;
                };

                const saveStockNote = async () => {
                    if (!user.value || !stockNoteForm.value.id) return;
                    await db.collection('users').doc(user.value.uid).collection('stocks').doc(stockNoteForm.value.id).update({
                        note: stockNoteForm.value.content
                    });
                    alert('✅ 筆記已儲存');
                    showStockNoteModal.value = false;
                };

                // v3.3.3: 日期解析輔助
                const parseDate = (str) => {
                    if (!str) return new Date();
                    return new Date(str.replace(/-/g, '/'));
                };



                // ★★★ v3.8.0: 直連 API ★★★
                // 台股（盤中）：Cloudflare Worker → MIS TWSE 批次即時報價
                // 台股（盤後）：TWSE Open API + TPEx Open API
                // 美股：Finnhub REST API
                const FINNHUB_API_KEY = 'd6klt59r01qg51f4ff00d6klt59r01qg51f4ff0g';
                const CF_PROXY = 'https://stock-proxy.chicken7999.workers.dev/?url=';

                // 台股快照 cache (Open API, 5分鐘更新一次)
                let _twMarketCache = null;
                let _twMarketCacheTs = 0;

                // 台股盤中快照 cache (MIS, 支援 40 筆分塊, 即時更新)
                let _twMisCache = new Map();
                let _twMisCacheTs = 0;

                // 從 TWSE/TPEx Open API 抓當日收盤（盤後用），透過 CF Proxy 避免 CORS
                const fetchTwSnapshotFromOpenApi = async () => {
                    const map = new Map();
                    try {
                        const j = await (await fetch(CF_PROXY + encodeURIComponent('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'))).json();
                        j.forEach(s => {
                            const price = parseFloat(s.ClosingPrice?.replace(/,/g, '') || '');
                            const change = parseFloat(s.Change?.replace(/[^-\d.]/g, '') || '0');
                            if (!isNaN(price) && price > 0)
                                map.set(s.Code, { price, prevClose: price - change, market: 'tse', name: s.Name });
                        });
                    } catch (e) { console.warn('[TWSE OpenAPI] 上市失敗', e); }
                    try {
                        const j = await (await fetch(CF_PROXY + encodeURIComponent('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes'))).json();
                        j.forEach(s => {
                            const price = parseFloat(s.Close?.replace(/,/g, '') || '');
                            const change = parseFloat(s.Change?.replace(/[^-\d.]/g, '') || '0');
                            if (!isNaN(price) && price > 0)
                                map.set(s.SecuritiesCompanyCode, { price, prevClose: price - change, market: 'otc', name: s.CompanyName });
                        });
                    } catch (e) { console.warn('[TPEx OpenAPI] 上櫃失敗', e); }
                    return map;
                };


                // 主快照函式 (僅走 Open API 兜底)
                const fetchTwMarketSnapshot = async () => {
                    const cacheTtl = 5 * 60 * 1000;
                    if (_twMarketCache && Date.now() - _twMarketCacheTs < cacheTtl) return _twMarketCache;

                    const map = await fetchTwSnapshotFromOpenApi();
                    _twMarketCache = map;
                    _twMarketCacheTs = Date.now();
                    return map;
                };

                // 通用的 retry + timeout 包装函式 (retry=重試次數, timeoutMs=超時限制)
                const fetchWithRetry = async (url, retry = 1, timeoutMs = 8000) => {
                    for (let i = 0; i <= retry; i++) {
                        try {
                            const controller = new AbortController();
                            const tid = setTimeout(() => controller.abort(), timeoutMs);
                            const resp = await fetch(url, { signal: controller.signal });
                            clearTimeout(tid);
                            return resp;
                        } catch (e) {
                            if (i < retry) {
                                console.warn(`[Fetch] 失敗，${i + 1} 秒後重試...`, url);
                                await new Promise(r => setTimeout(r, (i + 1) * 600));
                            } else {
                                throw e;
                            }
                        }
                    }
                };

                // MIS 抓取函式 (支援分塊以避開 URL 長度限制)
                const fetchMisTwse = async (exChList) => {
                    const map = new Map();
                    if (!exChList || exChList.length === 0) return map;

                    const chunkSize = 40;
                    const chunks = [];
                    for (let i = 0; i < exChList.length; i += chunkSize) {
                        chunks.push(exChList.slice(i, i + chunkSize));
                    }

                    // 改成依序抓取，避免同時發滿 6+ 個請求導致 Cloudflare 或證交所阻擋 (429 Too Many Requests)
                    for (const chunk of chunks) {
                        try {
                            const exCh = chunk.join('|');
                            const misUrl = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0&t=${Date.now()}`;
                            const j = await (await fetchWithRetry(CF_PROXY + encodeURIComponent(misUrl), 1, 8000)).json();
                            if (j.msgArray?.length > 0) {
                                j.msgArray.forEach(s => {
                                    let price = s.z;
                                    // z=盤中即時成交價；盤後可能為'-'
                                    // oz=今日收盤確定值（盤後優先）；pz=前一筆；y=昨收（最後手段）
                                    if (price === '-' || price === '') price = (s.oz && s.oz !== '-' && s.oz !== '') ? s.oz : (s.pz !== '-' && s.pz !== '') ? s.pz : s.y;
                                    const finalPrice = parseFloat(price);
                                    const prevClose = parseFloat(s.y);
                                    const market = s.ex === 'otc' ? 'otc' : 'tse';
                                    if (!isNaN(finalPrice) && finalPrice > 0)
                                        map.set(s.c, { price: finalPrice, prevClose: isNaN(prevClose) ? finalPrice : prevClose, market, name: s.n || s.nf || "" });
                                });
                            }
                        } catch (e) {
                            console.warn('[MIS] 批次抓取失敗 (已重試)', e);
                        }
                        // 稍微等待，避免瞬間請求過多
                        await new Promise(r => setTimeout(r, 300));
                    }
                    return map;
                };

                // ★★★ v4.5.0: Yahoo Finance v7 已失效(Unauthorized)，改用 v8 chart API ★★★
                // v8 endpoint: /v8/finance/chart/{symbol}?interval=1d&range=1d
                // 回傳 chart.result[0].meta.regularMarketPrice
                const fetchTwStockPriceYahoo = async (stock) => {
                    const cleanSym = stock.symbol.replace(/\.(TW|TWO)$/i, '');

                    // esb/otc → 先試 .TWO；tse/未知 → 先試 .TW
                    const firstSuffix = (stock.marketType === 'otc' || stock.marketType === 'esb') ? '.TWO' : '.TW';
                    const fallbackSuffix = firstSuffix === '.TWO' ? '.TW' : '.TWO';

                    const tryYahooV8 = async (suffix) => {
                        const yahooSym = `${cleanSym}${suffix}`;
                        try {
                            const url = `https://query2.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1d&range=1d`;
                            const resp = await fetchWithRetry(CF_PROXY + encodeURIComponent(url), 1, 8000);
                            const json = await resp.json();
                            const meta = json?.chart?.result?.[0]?.meta;
                            if (meta && meta.regularMarketPrice > 0) {
                                return {
                                    regularMarketPrice: meta.regularMarketPrice,
                                    previousClose: meta.previousClose || meta.chartPreviousClose || meta.regularMarketPrice,
                                    detectedSuffix: suffix
                                };
                            }
                        } catch (e) {
                            console.warn(`[Yahoo v8] ${cleanSym}${suffix} 失敗`, e);
                        }
                        return null;
                    };

                    let data = await tryYahooV8(firstSuffix);
                    if (!data) {
                        console.log(`[Yahoo v8] ${cleanSym}${firstSuffix} 無資料，自動嘗試 ${fallbackSuffix}`);
                        data = await tryYahooV8(fallbackSuffix);
                        if (data && user.value && stock.id) {
                            const correctedMarket = fallbackSuffix === '.TW' ? 'tse' : 'otc';
                            if (stock.marketType !== correctedMarket) {
                                console.log(`[Yahoo v8] 自動修正 ${cleanSym} marketType: ${stock.marketType} → ${correctedMarket}`);
                                stock.marketType = correctedMarket;
                                try {
                                    await db.collection('users').doc(user.value.uid).collection('stocks').doc(stock.id).update({ marketType: correctedMarket });
                                } catch (e) { console.warn('[Yahoo v8] marketType 修正寫入失敗', e); }
                            }
                        }
                    }

                    if (!data) return null;
                    return {
                        regularMarketPrice: data.regularMarketPrice,
                        previousClose: data.previousClose
                    };
                };

                // v4.8.2: 統一的台股個股取價入口 (Yahoo -> MIS -> Open API)
                const fetchTwStockPriceUnified = async (stock) => {
                    // 1. 第一優先：Yahoo Finance v8 (實時且最穩定)
                    let data = await fetchTwStockPriceYahoo(stock);
                    if (data) return data;

                    console.log(`[Unified Fetch] ${stock.symbol} Yahoo 無資料，降級至 MIS`);

                    // 2. 第二優先：TWSE MIS 單股即時查詢 (只查詢特定市場，不打包雙前綴)
                    let mt = stock.marketType;
                    if (!mt) {
                        mt = await detectMarketType(stock) || 'tse';
                    }
                    const cleanSym = stock.symbol.replace(/\.(TW|TWO)$/i, '');
                    if (mt !== 'esb') { // 興櫃不在 MIS
                        try {
                            const misMap = await fetchMisTwse([`${mt}_${cleanSym}.tw`]);
                            const misData = misMap.get(cleanSym);
                            if (misData) {
                                return {
                                    regularMarketPrice: misData.price,
                                    previousClose: misData.prevClose
                                };
                            }
                        } catch (e) {
                            console.warn(`[Unified Fetch] MIS 查詢失敗: ${stock.symbol}`, e);
                        }
                    }

                    // 3. 第三優先：Open API 快照保底 (昨收價)
                    const openApiMap = await fetchTwMarketSnapshot();
                    const openApiData = openApiMap.get(cleanSym);
                    if (openApiData) {
                        return {
                            regularMarketPrice: openApiData.price,
                            previousClose: openApiData.prevClose
                        };
                    }

                    return null;
                };

                // 判斷美股是否盤中 (簡單以時區判斷)
                const isUsMarketOpen = () => {
                    const nyTime = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
                    const day = nyTime.getDay();
                    const hours = nyTime.getHours();
                    const minutes = nyTime.getMinutes();
                    const totalMin = hours * 60 + minutes;
                    // 美東時間週一到週五，9:30 (570) 到 16:00 (960)
                    return day >= 1 && day <= 5 && totalMin >= 570 && totalMin < 960;
                };

                const fetchUsStockPrice = async (symbol) => {
                    try {
                        const r = await fetchWithRetry(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`, 1, 8000);
                        const j = await r.json();
                        // Finnhub: c = 最新成交價(盤中即時/盤後即為當日收盤), pc = 前一個交易日收盤
                        // 注意：盤後 j.c 就是當日收盤，不應再 fallback 到 j.pc（那才是更前一天）
                        if (j.c && j.c > 0) {
                            return {
                                regularMarketPrice: j.c,
                                previousClose: j.pc || j.c
                            };
                        }
                    } catch (e) {
                        console.warn(`[Finnhub] ${symbol} 失敗`, e);
                    }
                    return null;
                };

                // 一次性偵測上市/上櫃/興櫃 (v4.4.0: 加入 esb 支援；找不到回傳 null 而非預設 tse)
                const detectMarketType = async (stock) => {
                    if (stock.currency === 'USD') return 'us';
                    const cleanSym = stock.symbol.replace(/\.(TW|TWO)$/i, '');
                    const map = await fetchTwMarketSnapshot();
                    const d = map.get(cleanSym);
                    if (d) return d.market; // 'tse', 'otc', or 'esb'
                    return null; // 找不到，讓呼叫端決定 fallback（避免把興櫃誤記成 tse）
                };


                // 啟動時為未分類股票批次自動偵測（背景執行，不阻塞 UI）
                const autoDetectMarketTypes = async (unclassified) => {
                    if (!user.value || unclassified.length === 0) return;
                    console.log(`[v4.4.0] 自動偵測 ${unclassified.length} 支股票的上市/上櫃/興櫃屬性...`);
                    for (const stock of unclassified) {
                        try {
                            const marketType = await detectMarketType(stock);
                            if (marketType !== null) {
                                await db.collection('users').doc(user.value.uid).collection('stocks').doc(stock.id).update({ marketType });
                                console.log(`[偵測] ${stock.symbol} → ${marketType}`);
                            } else {
                                console.warn(`[偵測] ${stock.symbol} 無法判斷市場類型，保留原值`);
                            }
                        } catch (e) { console.warn(`[偵測失敗] ${stock.symbol}`, e); }
                        await new Promise(r => setTimeout(r, 600));
                    }
                    console.log('[v4.4.0] 偵測完成！');
                };

                // v4.8.0: 檢查已分類但可能已轉市場的股票（如興櫃轉上市）並自動修正
                const autoCorrectMarketTypes = async (classified) => {
                    if (!user.value || classified.length === 0) return;
                    const map = await fetchTwMarketSnapshot();
                    let correctedCount = 0;
                    for (const stock of classified) {
                        try {
                            const clean = stock.symbol.replace(/\.(TW|TWO)$/i, '');
                            const d = map.get(clean);
                            if (d && d.market !== stock.marketType) {
                                console.log(`[v4.8.0] 修正 ${stock.symbol}: ${stock.marketType} → ${d.market}`);
                                await db.collection('users').doc(user.value.uid).collection('stocks').doc(stock.id).update({ marketType: d.market });
                                correctedCount++;
                            }
                        } catch (e) { console.warn(`[v4.8.0] 修正失敗 ${stock.symbol}`, e); }
                        await new Promise(r => setTimeout(r, 300));
                    }
                    if (correctedCount > 0) console.log(`[v4.8.0] 共修正 ${correctedCount} 支股票的 marketType`);
                };

                // v3.8.0: 統一的股價抓取入口
                const fetchStockData = async (stock) => {
                    let mt = stock.marketType;
                    // marketType 缺失時，fallback 用 currency 判斷（新增股票可能沒有 marketType）
                    const isUs = mt === 'us' || (!mt && stock.currency === 'USD');
                    if (isUs) {
                        return await fetchUsStockPrice(stock.symbol);
                    } else {
                        // 台股：統一取價路徑 (Yahoo -> MIS -> Open API)
                        return await fetchTwStockPriceUnified(stock);
                    }
                };

                // ★★★ v3.8.0: getYahooData 改為直連版 (台股→MIS，美股→Finnhub) ★★★
                const getYahooData = async (symbol) => {
                    let s = symbol.toUpperCase();
                    const isTwStock = /^\d{4,6}[A-Z]?$/.test(s) || s.endsWith('.TW') || s.endsWith('.TWO');

                    // 台股：用 Open API 快照 lookup + 即時 MIS
                    if (isTwStock) {
                        const cleanSym = s.replace(/\.(TW|TWO)$/i, '');
                        const map = await fetchTwMarketSnapshot();
                        const d = map.get(cleanSym);
                        if (d) {
                            // 嘗試透過 MIS 抓取即時報價
                            const misMap = await fetchMisTwse([`${d.market}_${cleanSym}.tw`]);
                            const misData = misMap.get(cleanSym);
                            if (misData) {
                                return {
                                    symbol: `${cleanSym}.${d.market === 'otc' ? 'TWO' : 'TW'}`,
                                    name: d.name,
                                    regularMarketPrice: misData.price,
                                    previousClose: misData.prevClose
                                };
                            }
                            // 退回到 Open API
                            return {
                                symbol: `${cleanSym}.${d.market === 'otc' ? 'TWO' : 'TW'}`,
                                name: d.name,
                                regularMarketPrice: d.price,
                                previousClose: d.prevClose
                            };
                        }
                        // 備援方案：若 Open API 查無此代號（可能 TPEx API 遭阻擋或新股上市），直接向 MIS 查詢雙通道
                        try {
                            const misMap = await fetchMisTwse([`tse_${cleanSym}.tw`, `otc_${cleanSym}.tw`]);
                            const misData = misMap.get(cleanSym);
                            if (misData) {
                                return {
                                    symbol: `${cleanSym}.${misData.market === 'otc' ? 'TWO' : 'TW'}`,
                                    name: misData.name || cleanSym,
                                    regularMarketPrice: misData.price,
                                    previousClose: misData.prevClose
                                };
                            }
                        } catch (e) {
                            console.warn('[getYahooData] MIS 直連查詢失敗', e);
                        }
                        return null;
                    }

                    // 美股 / 匯率：直連 Finnhub
                    try {
                        const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${s}&token=${FINNHUB_API_KEY}`);
                        const j = await r.json();
                        if (j.c && j.c > 0) {
                            let cpName = undefined;
                            try {
                                const profileRes = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${s}&token=${FINNHUB_API_KEY}`);
                                const profileJson = await profileRes.json();
                                if (profileJson && profileJson.name) cpName = profileJson.name;
                            } catch (e) { /* silent */ }
                            return {
                                symbol: s,
                                name: cpName,
                                regularMarketPrice: j.c,
                                previousClose: j.pc || j.c
                            };
                        }
                    } catch (e) { /* silent */ }
                    return null;
                };
                const autoFetchName = async () => { const s = form.value.symbol; if (!s) return; if (/^\d/.test(s)) { form.value.currency = 'TWD'; } else if (/^[A-Za-z\.-]+$/.test(s)) { form.value.currency = 'USD'; form.value.marketType = 'us'; } if (!form.value.name) form.value.name = '查詢中...'; const d = await getYahooData(s); if (d) { if (form.value.name === '查詢中...') form.value.name = d.name || d.symbol; form.value.currentPrice = d.regularMarketPrice; form.value.previousClose = d.previousClose; } else { if (form.value.name === '查詢中...') form.value.name = ''; alert('查無代號'); } };
                const autoFetchTransName = async () => { const s = transForm.value.symbol; if (!s) return; const localStock = stocks.value.find(st => st.symbol && st.symbol.toUpperCase() === s.toUpperCase()); if (localStock) { transForm.value.name = localStock.name; form.value.currency = localStock.currency; return; } if (/^\d/.test(s)) form.value.currency = 'TWD'; else if (/^[A-Za-z\.-]+$/.test(s)) form.value.currency = 'USD'; if (!transForm.value.name) transForm.value.name = '查詢中...'; const d = await getYahooData(s); if (d) { if (transForm.value.name === '查詢中...') transForm.value.name = d.name || d.symbol; } else { if (transForm.value.name === '查詢中...') transForm.value.name = ''; } };
                // [主程式] 批次更新股價 (支援分流 + 必定更新匯率)
                const fetchPrices = async (marketType) => {
                    // 基本檢查
                    if (!user.value || stocks.value.length === 0) return;

                    // 1. 根據按鈕類型篩選股票
                    const targetStocks = stocks.value.filter(stock => {
                        const s = stock.symbol.toUpperCase();
                        // 判斷是否為台股格式 (4-6位數字，或是結尾有 .TW/.TWO)
                        const isTwStock = /^\d{4,6}[A-Z]?$/.test(s) || s.endsWith('.TW') || s.endsWith('.TWO');

                        if (marketType === 'TW') return isTwStock;   // 按「台股」：只回傳台股
                        if (marketType === 'US') return !isTwStock;  // 按「美股」：只回傳非台股
                        return true; // 防呆
                    });

                    // 如果該分類沒有股票，跳出提示並結束
                    if (targetStocks.length === 0) {
                        alert(marketType === 'TW' ? "您的清單中沒有台股" : "您的清單中沒有美股");
                        return;
                    }

                    // 設定現在正在忙碌的對象 (讓按鈕開始轉圈圈)
                    loadingTarget.value = marketType;

                    // =========================================================
                    // ★★★ 第一步：更新匯率 (直連 exchangerate-api.com) ★★★
                    // =========================================================
                    try {
                        const rateResp = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
                        const rateJson = await rateResp.json();
                        const newRate = rateJson.rates.TWD;
                        if (newRate && newRate > 0) {
                            exchangeRate.value = newRate;
                            await db.collection('users').doc(user.value.uid).collection('settings').doc('config').set({
                                exchangeRate: newRate
                            }, { merge: true });
                            console.log(`匯率已更新: ${newRate}`);
                        }
                    } catch (e) {
                        console.warn('匯率更新失敗，將使用舊匯率', e);
                    }

                    // =========================================================
                    // 第二步：開始更新股票迴圈 (統一調用 fetchStockData)
                    // =========================================================
                    const batch = db.batch();
                    let hasUpdates = false;
                    let successCount = 0;
                    let failCount = 0;

                    // 台股與美股分流限速：台股每秒 concurrent 4, delay 400ms；美股 Finnhub 每秒 concurrent 3, delay 3050ms
                    const CONCURRENT_LIMIT = marketType === 'US' ? 3 : 4;
                    const BATCH_DELAY = marketType === 'US' ? 3050 : 400;

                    for (let i = 0; i < targetStocks.length; i += CONCURRENT_LIMIT) {
                        const batchStocks = targetStocks.slice(i, i + CONCURRENT_LIMIT);
                        batchStocks.forEach(stock => { stockStates.value[stock.id] = 'loading'; });

                        await Promise.all(batchStocks.map(async (stock) => {
                            try {
                                const data = await fetchStockData(stock);
                                if (data) {
                                    stock.currentPrice = data.regularMarketPrice;
                                    stock.previousClose = data.previousClose;
                                    const ref = db.collection('users').doc(user.value.uid).collection('stocks').doc(stock.id);
                                    batch.update(ref, { currentPrice: data.regularMarketPrice, previousClose: data.previousClose });
                                    hasUpdates = true;
                                    successCount++;
                                    stockStates.value[stock.id] = 'success';
                                } else {
                                    failCount++;
                                    stockStates.value[stock.id] = 'error';
                                }
                            } catch (err) {
                                console.error(`Update failed for ${stock.symbol}`, err);
                                failCount++;
                                stockStates.value[stock.id] = 'error';
                            }
                            setTimeout(() => {
                                if (stockStates.value[stock.id] === 'success') stockStates.value[stock.id] = null;
                            }, 300000);
                        }));

                        if (i + CONCURRENT_LIMIT < targetStocks.length) {
                            await new Promise(r => setTimeout(r, BATCH_DELAY));
                        }
                    }

                    // 如果有資料更新，寫入資料庫並儲存快照
                    if (hasUpdates) {
                        await batch.commit();
                        setTimeout(saveDailySnapshot, 500);
                    }

                    const now = new Date();
                    lastUpdated.value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

                    // 更新結束，重置按鈕狀態
                    loadingTarget.value = null;


                    const typeName = marketType === 'TW' ? '台股' : (marketType === 'US' ? '美股' : '全部');
                    alert(`${typeName} 更新完成！\n\n✅ 成功: ${successCount} 筆\n❌ 失敗: ${failCount} 筆`);
                };

                // [v4.8.2] 單一股票更新：統一走 fetchStockData (Yahoo -> MIS -> OpenAPI)
                const updateSingleStock = async (stock) => {
                    if (!user.value) return;

                    stockStates.value[stock.id] = 'loading';

                    try {
                        const data = await fetchStockData(stock);

                        if (data) {
                            stock.currentPrice = data.regularMarketPrice;
                            stock.previousClose = data.previousClose;

                            await db.collection('users').doc(user.value.uid).collection('stocks').doc(stock.id).update({
                                currentPrice: data.regularMarketPrice,
                                previousClose: data.previousClose
                            });

                            stockStates.value[stock.id] = 'success';
                            saveDailySnapshot();
                        } else {
                            stockStates.value[stock.id] = 'error';
                        }
                    } catch (e) {
                        console.error(`Single update failed for ${stock.symbol}`, e);
                        stockStates.value[stock.id] = 'error';
                    }

                    setTimeout(() => {
                        if (stockStates.value[stock.id] === 'success') {
                            stockStates.value[stock.id] = null;
                        }
                    }, 300000);
                };


                const fetchExchangeRate = async () => { try { const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD'); const d = await r.json(); exchangeRate.value = d.rates.TWD; } catch (e) { } };

                const sortTransaction = (key) => { if (sortKeyTrans.value === key) sortOrderTrans.value = sortOrderTrans.value === 'asc' ? 'desc' : 'asc'; else { sortKeyTrans.value = key; sortOrderTrans.value = 'desc'; } };
                const sortDividend = (key) => { if (sortKeyDiv.value === key) sortOrderDiv.value = sortOrderDiv.value === 'asc' ? 'desc' : 'asc'; else { sortKeyDiv.value = key; sortOrderDiv.value = 'desc'; } };

                function calculateStats(subset) { let v = 0, c = 0, d = 0; subset.forEach(s => { v += s.currentPrice * s.shares; c += s.avgCost * s.shares; d += (s.dividends || 0); }); return { value: v, cost: c, dividend: d, pnl: v - c }; }
                // Formatting functions imported from utils
                const getAmountClass = (tx) => { if (tx.type === 'buy' || tx.type === 'withdraw' || tx.type === 'repay' || tx.type === 'borrow') return ''; if (tx.type === 'sell' || tx.type === 'dividend' || tx.type === 'deposit') return isDarkMode.value ? 'text-yellow-400' : 'text-yellow-600'; return ''; };
                // getAmountSign imported from utils


                return {
                    clearAllUserData, 
                    user, login, logout, stocks, exchangeRate, lastUpdated, isLoading, viewMode, isMobile, showPrivacy, isDarkMode, toggleDarkMode, activeSection, toggleSection, showChangelog, hideZeroShares, defaultPrivacyHidden,
                    twStats, usStats, grandTotalValue, grandTotalAssets, grandTotalExposure, grandTotalPnL, twPieRatios, usPieRatios, twStockList, usStockList, leverageRatio, exposureRatio,
                    financialAssets, financialLoans, financialNetWorth, financialExposure,
                    showModal, isEditing, form, openModal, editStock, closeModal, saveStock, deleteStock,
                    showTransModal, transForm, openTransModal, closeTransModal, submitTransaction, isFundMode, openFundModal,
                    autoFetchName, autoFetchTransName, fetchPrices, formatNumber, formatCurrency, getPnlClass, getRoi, formatChange, getTypeName, getAmountClass, getAmountSign,
                    chartStartDate, chartEndDate, drawChart, chartPnl, prevDayData, exportData, realizedGains, realizedTotalTw, realizedTotalUs,
                    divRange, divSearchQuery, setDivRange, divStartDate, divEndDate, fetchDividends, dividendRecords, dividendRangeTw, dividendRangeUs,
                    transactionHistory, fetchTransactions, deleteTransaction, deleteDividend, deleteRealized,
                    transStartDate, transEndDate, sortTransaction, sortDividend, sortedTransactions, sortedDividends,
                    realizedStartDate, realizedEndDate, fetchRealizedGains, cashData,
                    transFilterType, transSearchQuery, jumpToFundHistory,
                    showHistoryModal, historyRecords, openHistoryModal, deleteHistoryRecord,
                    notes, openNoteModal, closeNoteModal, saveNote, deleteNote, showNoteModalVisible, noteForm,
                    realizedSearchQuery, sortRealized, sortedRealizedGains, 
                    realizedRange, setRealizedRange,
                    showDeleteModal, pendingDeleteTx, executeDelete,
                    showHistoryEditModalVisible, openHistoryEditModal, saveHistoryRecord, historyEditForm, calculateHistoryNetWorth,
                    loanList, totalLoanBalance, totalMonthlyPayment, activeLoans, archivedLoans, showArchivedLoansList, toggleArchiveLoan, showLoanMgrModal, loanForm, openLoanMgrModal, editLoanAccount, saveLoanAccount, deleteLoanAccount, openLoanModal, isLoanMode, loanCashMode,
                    inlineNewLoan, inlineLoanName, saveInlineLoanAccount,
                    exportToExcel, exportSimplifiedPortfolio,
                    showSettingsModal, saveSettings,
                    triggerImport, fileInput, handleImport,
                    driveLoading, exportDataToDrive, importFromDrive,
                    setChartRange, currentRange, historyFilterYear, availableYears,
                    openStockNoteModal, showStockNoteModal, stockNoteForm, saveStockNote,

                    updateSingleStock, stockStates, loadingTarget,
                    fetchStockData, detectMarketType, autoDetectMarketTypes,
                    sectionLoading,
                    showEditTxModal, editTxForm, openEditTxModal, saveEditTx,
                    realEstateList, realEstateTotalMarket, realEstateTotalMortgage, realEstateNetValue, realEstateBookPnL,
                    showRealEstateModal, realEstateForm, openRealEstateModal, saveRealEstate, deleteRealEstate,
                    getLoanName, getReMortgageTotal, getReMortgageLoans, toggleReMortgageLoan,

                    monthlyProfitData, monthlyProfitRange, drawMonthlyChart,

                    futuresMargin, futuresPositions, showFuturesModal, futuresForm, showFuturesMarginModal, futuresMarginForm, futuresLoading, futuresTransactions,
                    futuresTotalUnrealizedPnL, futuresEquity, futuresTotalMarginUsed, futuresTotalExposure, futuresRiskRatio, futuresLeverageRatio,
                    openFuturesModal, saveFuturesPosition, deleteFuturesPosition, closeFuturesPosition, openFuturesMarginModal, adjustFuturesMargin, autoFetchTaiexIndexPrice, fetchFuturesPricesDirect, onFuturesSymbolChange, deleteFuturesTransaction, futuresHistoryTab, getFuturesDisplayName, futuresTotalMarginCashTwd,
                    investmentsTab, performanceTab, overviewTab,
                    mutualFundList, showMutualFundModal, mutualFundForm, mutualFundTotalCost, mutualFundTotalValue, mutualFundTotalPnL, openMutualFundModal, saveMutualFund, deleteMutualFund
                };
            }
        }).mount('#app');
    
