import { db, auth } from './firebase-config.js';
import { getLocalDate, formatNumber, formatCurrency, getPnlClass, getRoi, formatChange, getTypeName, getAmountSign } from './utils/format.js';

import { 
    user, stocks, exchangeRate, lastUpdated, lastUpdatedTs, loadingTarget, isLoading, viewMode, isMobile, showPrivacy, defaultPrivacyHidden, hideZeroShares, showSettingsModal, isDarkMode, activeSection, showChangelog, stockStates, sectionLoading, xirrValue, xirrStartDate, xirrStartVal, xirrEndVal, xirrFlowCount, showStockNoteModal, stockNoteForm, showHistoryModal, historyRecords, historyFilterYear, availableYears, showDeleteModal, pendingDeleteTx, showEditTxModal, editTxForm, showHistoryEditModalVisible, historyEditForm, notes, showNoteModalVisible, noteForm, loanList, showLoanMgrModal, inlineNewLoan, inlineLoanName, loanForm, cashData, prevDayData, realEstateList, showRealEstateModal, realEstateForm, chartStartDate, chartEndDate, chartPnl, currentRange, divRange, divSearchQuery, divStartDate, divEndDate, realizedStartDate, realizedEndDate, transStartDate, transEndDate, transFilterType, transSearchQuery, sortKeyTrans, sortOrderTrans, sortKeyDiv, sortOrderDiv, realizedGains, realizedSearchQuery, sortKeyRealized, sortOrderRealized, realizedRange, dividendRecords, transactionHistory, showModal, isEditing, form, showTransModal, isFundMode, isLoanMode, loanCashMode, transForm, isPriceStale,
    monthlyProfitData, monthlyProfitRange
} from './store/index.js';
const { createApp, ref, computed, onMounted, watch } = Vue;

        createApp({
            setup() {
                // --- 1. 變數定義區 ---
                let unsubscribeRealEstate = null;
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
                        if (u) { loadUserData(u.uid); fetchPreviousDayData(u.uid); fetchCash(u.uid); fetchNotes(u.uid); fetchLoans(u.uid); fetchRealEstate(u.uid); }
                        else { stocks.value = []; realizedGains.value = []; dividendRecords.value = []; transactionHistory.value = []; cashData.value = { twd: 0, usd: 0, loan: 0 }; notes.value = []; loanList.value = []; realEstateList.value = []; }
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
                const totalLoanBalance = computed(() => loanList.value.reduce((acc, cur) => acc + (cur.balance || 0), 0));
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
                const grandTotalAssets = computed(() => {
                    const stockVal = twStats.value.value + (usStats.value.value * exchangeRate.value);
                    const cashVal = (cashData.value.twd || 0) + ((cashData.value.usd || 0) * exchangeRate.value);
                    return stockVal + cashVal + realEstateTotalMarket.value;
                });
                // v4.5.0: 曝險總額 (考慮正2等槓桿倍數)
                const grandTotalExposure = computed(() => {
                    const twExposure = twStockList.value.reduce((acc, s) => acc + (s.currentPrice * s.shares * (s.multiplier || 1)), 0);
                    const usExposure = usStockList.value.reduce((acc, s) => acc + (s.currentPrice * s.shares * (s.multiplier || 1)), 0) * exchangeRate.value;
                    const cashVal = (cashData.value.twd || 0) + ((cashData.value.usd || 0) * exchangeRate.value);
                    return twExposure + usExposure + cashVal + realEstateTotalMarket.value;
                });
                // v4.0.0: 淨資產 = 總資產 - 所有負債(貸款)
                const grandTotalValue = computed(() => grandTotalAssets.value - totalLoanBalance.value);
                const grandTotalPnL = computed(() => twStats.value.pnl + (usStats.value.pnl * exchangeRate.value));
                // v4.4.0: 帳戶槓桿 = 總資產 / 淨資產
                const leverageRatio = computed(() => {
                    if (grandTotalValue.value <= 0) return 1;
                    return grandTotalAssets.value / grandTotalValue.value;
                });
                // v4.5.0: 曝險比例 = 總曝險 / 淨資產
                const exposureRatio = computed(() => {
                    if (grandTotalValue.value <= 0) return 1;
                    return grandTotalExposure.value / grandTotalValue.value;
                });
                const realizedTotalTw = computed(() => sortedRealizedGains.value.filter(r => r.currency === 'TWD').reduce((acc, cur) => acc + cur.pnl, 0));
                const realizedTotalUs = computed(() => sortedRealizedGains.value.filter(r => r.currency === 'USD').reduce((acc, cur) => acc + cur.pnl, 0));

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

                // v3.6.0: XIRR debounce
                let xirrDebounceTimer = null;
                const debouncedXirr = () => { clearTimeout(xirrDebounceTimer); xirrDebounceTimer = setTimeout(computeSystemXirr, 3000); };
                // 觸發計算
                watch(grandTotalValue, () => {
                    if (grandTotalValue.value > 0) debouncedXirr();
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

                watch(isDarkMode, () => { if (activeSection.value === 'chart') setTimeout(drawChart, 100); });
                const toggleSection = (s) => {
                    if (activeSection.value === s) activeSection.value = '';
                    else {
                        activeSection.value = s;
                        if (s === 'chart') setTimeout(drawChart, 100);
                        if (s === 'pie') setTimeout(drawPieCharts, 100);
                        if (s === 'realized') fetchRealizedGains();
                        if (s === 'dividend') fetchDividends();
                        if (s === 'transactions') fetchTransactions();
                        if (s === 'monthly') setTimeout(drawMonthlyChart, 100);
                    }
                };
                const jumpToFundHistory = () => { setTimeout(() => { document.querySelector('.zen-card.mb-8 h4').scrollIntoView({ behavior: 'smooth' }); }, 100); };
                const loadUserData = (uid) => {
                    if (unsubscribe) unsubscribe(); unsubscribe = db.collection('users').doc(uid).collection('stocks').onSnapshot(snap => {
                        stocks.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                        if (stocks.value.length > 0) saveDailySnapshot();
                        // v3.6.0: 自動偵測未分類股票的市場類型（背景執行，不阻塞 UI）
                        const unclassified = stocks.value.filter(s => !s.marketType && s.currency !== 'USD');
                        if (unclassified.length > 0) setTimeout(() => autoDetectMarketTypes(unclassified), 5000);
                    });
                };
                const fetchCash = (uid) => { if (unsubscribeCash) unsubscribeCash(); unsubscribeCash = db.collection('users').doc(uid).collection('portfolio').doc('cash').onSnapshot(doc => { if (doc.exists) cashData.value = doc.data(); else cashData.value = { twd: 0, usd: 0, loan: 0 }; if (cashData.value.loan > 0 && loanList.value.length === 0) { setTimeout(() => migrateLegacyLoan(uid, cashData.value.loan), 1000); } setTimeout(saveDailySnapshot, 1000); }); };
                const fetchLoans = (uid) => { if (unsubscribeLoans) unsubscribeLoans(); unsubscribeLoans = db.collection('users').doc(uid).collection('loans').onSnapshot(snap => { loanList.value = snap.docs.map(d => ({ id: d.id, ...d.data() })); }); };
                const migrateLegacyLoan = async (uid, amount) => { if (loanList.value.length > 0) return; await db.collection('users').doc(uid).collection('loans').add({ name: '原有借款', balance: amount, currency: 'TWD' }); await db.collection('users').doc(uid).collection('portfolio').doc('cash').update({ loan: 0 }); };
                const fetchNotes = (uid) => { if (unsubscribeNotes) unsubscribeNotes(); unsubscribeNotes = db.collection('users').doc(uid).collection('notes').orderBy('date', 'desc').onSnapshot(snap => { notes.value = snap.docs.map(d => ({ id: d.id, ...d.data() })); }); };
                // v4.0.0: 房地產 CRUD
                const fetchRealEstate = (uid) => { if (unsubscribeRealEstate) unsubscribeRealEstate(); unsubscribeRealEstate = db.collection('users').doc(uid).collection('real_estate').onSnapshot(snap => { realEstateList.value = snap.docs.map(d => ({ id: d.id, ...d.data() })); }); };
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
                    debouncedXirr();
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
                const deleteHistoryRecord = async (date) => { if (!confirm(`確定要刪除 ${date} 的歷史紀錄嗎？`)) return; await db.collection('users').doc(user.value.uid).collection('history').doc(date).delete(); await openHistoryModal(); drawChart(); debouncedXirr(); };
                const openHistoryEditModal = (rec) => { historyEditForm.value = { date: rec.date, twVal: rec.twVal || 0, usVal: rec.usVal || 0, twCash: rec.twCash || 0, usCash: rec.usCash || 0, loan: rec.loan || 0, realestate: rec.realestate || rec.realEstateVal || 0 }; showHistoryEditModalVisible.value = true; };
                const calculateHistoryNetWorth = () => { const asset = (historyEditForm.value.twVal || 0) + (historyEditForm.value.twCash || 0) + ((historyEditForm.value.usVal || 0) + (historyEditForm.value.usCash || 0)) * exchangeRate.value + (historyEditForm.value.realestate || 0); const loan = historyEditForm.value.loan || 0; return asset - loan; };
                const saveHistoryRecord = async () => { if (!user.value) return; const newNetWorth = calculateHistoryNetWorth(); await db.collection('users').doc(user.value.uid).collection('history').doc(historyEditForm.value.date).update({ twVal: historyEditForm.value.twVal, usVal: historyEditForm.value.usVal, twCash: historyEditForm.value.twCash, usCash: historyEditForm.value.usCash, loan: historyEditForm.value.loan, realestate: historyEditForm.value.realestate, totalVal: newNetWorth }); showHistoryEditModalVisible.value = false; await openHistoryModal(); drawChart(); debouncedXirr(); };
                const openLoanMgrModal = () => { showLoanMgrModal.value = true; loanForm.value = { id: null, name: '', balance: 0 }; };
                const editLoanAccount = (l) => { loanForm.value = { ...l }; };
                const saveLoanAccount = async () => { if (!user.value || !loanForm.value.name) return alert('請輸入名稱'); const data = { name: loanForm.value.name, balance: loanForm.value.balance || 0, currency: 'TWD' }; if (loanForm.value.id) await db.collection('users').doc(user.value.uid).collection('loans').doc(loanForm.value.id).update(data); else await db.collection('users').doc(user.value.uid).collection('loans').add(data); loanForm.value = { id: null, name: '', balance: 0 }; };
                const deleteLoanAccount = async (l) => { if (!confirm(`確定刪除 ${l.name}？(這不會影響已發生的交易紀錄)`)) return; await db.collection('users').doc(user.value.uid).collection('loans').doc(l.id).delete(); };
                // Inline 新增帳戶（從到 Modal 內創建，建完自動選中）
                const saveInlineLoanAccount = async () => {
                    if (!user.value || !inlineLoanName.value) return;
                    const data = { name: inlineLoanName.value.trim(), balance: 0, currency: 'TWD' };
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

                const executeDelete = async (revertCash) => { showDeleteModal.value = false; const tx = pendingDeleteTx.value; if (!tx) return; if (revertCash) { if (tx.type === 'deposit') await updateCash(tx.currency, -Math.abs(tx.totalAmount), 0); else if (tx.type === 'withdraw') await updateCash(tx.currency, Math.abs(tx.totalAmount), 0); else if (tx.type === 'borrow') { if (tx.loanId) await updateLoanBalance(tx.loanId, -Math.abs(tx.totalAmount)); else alert('此為舊版借款紀錄，請手動調整對應帳戶餘額。'); if (tx.cashSynced === true) await updateCash(tx.currency || 'TWD', -Math.abs(tx.totalAmount), 0); } else if (tx.type === 'repay') { if (tx.loanId) await updateLoanBalance(tx.loanId, Math.abs(tx.totalAmount)); if (tx.cashSynced === true) await updateCash(tx.currency || 'TWD', Math.abs(tx.totalAmount), 0); } else if (tx.type === 'dividend') { await updateCash(tx.currency, -Math.abs(tx.totalAmount), 0); const stock = stocks.value.find(s => s.symbol === tx.symbol); if (stock) { await db.collection('users').doc(user.value.uid).collection('stocks').doc(stock.id).update({ dividends: Math.max(0, (stock.dividends || 0) - tx.totalAmount) }); } } else if (tx.type === 'buy') { await updateCash(tx.currency, Math.abs(tx.totalAmount), 0); const stock = stocks.value.find(s => s.symbol === tx.symbol); if (stock) { const ns = stock.shares - tx.shares; if (ns <= 0) { await db.collection('users').doc(user.value.uid).collection('stocks').doc(stock.id).delete(); } else { const remainingValue = (stock.shares * stock.avgCost) - tx.totalAmount; const na = remainingValue > 0 ? remainingValue / ns : 0; await db.collection('users').doc(user.value.uid).collection('stocks').doc(stock.id).update({ shares: ns, avgCost: na }); } } } else if (tx.type === 'sell') { alert('系統提示：已將您的賣出金額從現金中扣除。但因系統無法追蹤原銷售股票之成本紀錄，請您手動至「已實現損益」與「庫存」調整對應股數與紀錄，以確保資料正確。'); await updateCash(tx.currency, -Math.abs(tx.totalAmount), 0); } } await db.collection('users').doc(user.value.uid).collection('transactions').doc(tx.id).delete(); fetchTransactions(); setTimeout(async () => { await saveDailySnapshot(); if (activeSection.value === 'transactions') fetchTransactions(); if (activeSection.value === 'realized') fetchRealizedGains(); if (activeSection.value === 'chart') drawChart(); }, 500); pendingDeleteTx.value = null; };
                const deleteDividend = async (rec) => { if (!confirm('刪除股息？(現金將自動扣回)')) return; const stock = stocks.value.find(s => s.symbol === rec.symbol); if (stock) { await db.collection('users').doc(user.value.uid).collection('stocks').doc(stock.id).update({ dividends: Math.max(0, (stock.dividends || 0) - rec.amount) }); } await updateCash(rec.currency, -rec.amount, 0); await db.collection('users').doc(user.value.uid).collection('dividends').doc(rec.id).delete(); fetchDividends(); setTimeout(async () => { await saveDailySnapshot(); if (activeSection.value === 'chart') drawChart(); }, 500); };
                const deleteRealized = async (id) => { if (!confirm('刪除？')) return; await db.collection('users').doc(user.value.uid).collection('realized_gains').doc(id).delete(); fetchRealizedGains(); };
                const saveDailySnapshot = async () => { if (!user.value) return; const todayStr = getLocalDate(); const historyRef = db.collection('users').doc(user.value.uid).collection('history').doc(todayStr); const currentHour = new Date().getHours(); const snapshot = { date: todayStr, timestamp: firebase.firestore.FieldValue.serverTimestamp(), savedHour: currentHour, totalVal: grandTotalValue.value, twVal: twStats.value.value, usVal: usStats.value.value, twCash: cashData.value.twd || 0, usCash: cashData.value.usd || 0, loan: totalLoanBalance.value, totalPnL: grandTotalPnL.value, twPnL: twStats.value.pnl, usPnL: usStats.value.pnl, realestate: realEstateTotalMarket.value, leverage: leverageRatio.value, exposure: exposureRatio.value }; if (currentHour >= 21) { const doc = await historyRef.get(); if (doc.exists) { const existingSavedHour = doc.data().savedHour; if (existingSavedHour !== undefined && existingSavedHour < 21 && doc.data().totalVal > 0) { return; } } } await historyRef.set(snapshot, { merge: true }); debouncedXirr(); };

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
                        const asset = (x.twVal || 0) + (x.twCash || 0) + ((x.usVal || 0) + (x.usCash || 0)) * exchangeRate.value + (x.realestate || 0);
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
                const drawPieCharts = () => { if (pieTwInstance) pieTwInstance.destroy(); if (pieUsInstance) pieUsInstance.destroy(); const tooltipOptions = { callbacks: { label: function (c) { const l = c.label || ''; const v = c.raw; const t = c.chart._metasets[c.datasetIndex].total; const p = t > 0 ? ((v / t) * 100).toFixed(1) + '%' : '0%'; const fv = c.chart.canvas.id === 'pieTw' ? formatCurrency(v, 'TWD') : formatCurrency(v, 'USD'); return `${l}: ${fv} (${p})`; } } }; if (document.getElementById('pieTw') && twStockList.value.length) pieTwInstance = new Chart(document.getElementById('pieTw'), { type: 'doughnut', data: { labels: twStockList.value.map(s => s.name || s.symbol), datasets: [{ data: twStockList.value.map(s => s.currentPrice * s.shares), backgroundColor: ['#3b82f6', '#2563eb', '#1d4ed8', '#60a5fa', '#93c5fd'] }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: tooltipOptions } } }); if (document.getElementById('pieUs') && usStockList.value.length) pieUsInstance = new Chart(document.getElementById('pieUs'), { type: 'doughnut', data: { labels: usStockList.value.map(s => s.name || s.symbol), datasets: [{ data: usStockList.value.map(s => s.currentPrice * s.shares), backgroundColor: ['#ef4444', '#dc2626', '#b91c1c', '#f87171', '#fca5a5'] }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: tooltipOptions } } }); };

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
                        setTimeout(async () => { await saveDailySnapshot(); if (activeSection.value === 'chart') drawChart(); }, 500);
                        return;
                    }
                    if (isFundMode.value) { if (!transForm.value.totalAmount) return alert('請輸入金額'); const amount = transForm.value.type === 'deposit' ? transForm.value.totalAmount : -transForm.value.totalAmount; await updateCash(form.value.currency, amount, 0); await db.collection('users').doc(user.value.uid).collection('transactions').add(logData); closeTransModal(); setTimeout(async () => { await saveDailySnapshot(); if (activeSection.value === 'chart') drawChart(); }, 500); return; } if (transForm.value.type === 'dividend') { if (!transForm.value.totalAmount) return alert('請輸入金額'); const dividendData = { ...logData, amount: transForm.value.totalAmount }; await db.collection('users').doc(user.value.uid).collection('dividends').add(dividendData); await db.collection('users').doc(user.value.uid).collection('transactions').add(logData); await updateCash(form.value.currency, transForm.value.totalAmount, 0); const existingStock = stocks.value.find(s => s.symbol === transForm.value.symbol); if (existingStock) { await db.collection('users').doc(user.value.uid).collection('stocks').doc(existingStock.id).update({ dividends: (existingStock.dividends || 0) + transForm.value.totalAmount }); } closeTransModal(); setTimeout(async () => { await saveDailySnapshot(); if (activeSection.value === 'chart') drawChart(); }, 500); return; } if (!transForm.value.shares || !transForm.value.totalAmount) return alert('請輸入完整資訊'); logData.price = transForm.value.totalAmount / transForm.value.shares; let stockId = transForm.value.id; let currentShares = transForm.value.currentShares; let currentAvg = transForm.value.currentAvg; if (!stockId) { const existing = stocks.value.find(s => s.symbol === transForm.value.symbol); if (existing) { stockId = existing.id; currentShares = existing.shares; currentAvg = existing.avgCost; } else if (transForm.value.type === 'buy') { const newDoc = await db.collection('users').doc(user.value.uid).collection('stocks').add({ symbol: transForm.value.symbol, name: transForm.value.name, currency: form.value.currency, marketType: form.value.currency === 'USD' ? 'us' : '', shares: 0, avgCost: 0, currentPrice: 0, dividends: 0 }); stockId = newDoc.id; } else { const pnl = transForm.value.totalAmount - 0; await db.collection('users').doc(user.value.uid).collection('realized_gains').add({ ...logData, pnl: pnl, price: logData.price }); await db.collection('users').doc(user.value.uid).collection('transactions').add(logData); await updateCash(form.value.currency, transForm.value.totalAmount, 0); closeTransModal(); return; } } let ns = 0, na = 0; if (transForm.value.type === 'buy') { ns = currentShares + transForm.value.shares; const oldTotal = currentShares * currentAvg; na = (oldTotal + transForm.value.totalAmount) / ns; await updateCash(form.value.currency, -transForm.value.totalAmount, 0); } else { if (transForm.value.shares > currentShares) return alert('股數不足'); ns = currentShares - transForm.value.shares; na = currentAvg; const pnl = transForm.value.totalAmount - (transForm.value.shares * currentAvg); await db.collection('users').doc(user.value.uid).collection('realized_gains').add({ ...logData, pnl: pnl, price: logData.price }); await updateCash(form.value.currency, transForm.value.totalAmount, 0); } await db.collection('users').doc(user.value.uid).collection('transactions').add(logData); if (stockId) { const ref = db.collection('users').doc(user.value.uid).collection('stocks').doc(stockId); await ref.update({ shares: ns, avgCost: na }); if (ns === 0 && confirm('股數歸零，是否刪除此庫存項目？')) await ref.delete(); } setTimeout(async () => { await saveDailySnapshot(); if (activeSection.value === 'transactions') fetchTransactions(); if (activeSection.value === 'chart') drawChart(); }, 500); closeTransModal();
                };

                const openModal = () => { isEditing.value = false; form.value = { id: Date.now().toString(), symbol: '', name: '', currency: 'TWD', marketType: '', shares: 0, avgCost: 0, totalCostInput: 0, currentPrice: 0, dividends: 0, previousClose: 0, multiplier: 1 }; showModal.value = true; };
                const editStock = (s) => { isEditing.value = true; form.value = { ...s, totalCostInput: parseFloat((s.shares * s.avgCost).toFixed(2)), multiplier: s.multiplier || 1 }; showModal.value = true; };
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

                // v3.3.4: XIRR 核心邏輯
                const calcXIRR = (transactions) => {
                    if (transactions.length < 2) return 0;
                    transactions.sort((a, b) => a.dateObj - b.dateObj);

                    if (transactions.length === 2) {
                        const start = transactions[0];
                        const end = transactions[1];
                        if (start.amount >= 0 || end.amount <= 0) return 0;

                        const days = (end.dateObj - start.dateObj) / (1000 * 60 * 60 * 24);
                        if (days <= 0) return 0;

                        const ratio = end.amount / Math.abs(start.amount);
                        const rate = Math.pow(ratio, 365 / days) - 1;
                        return isNaN(rate) ? 0 : rate * 100;
                    }

                    const guesses = [0.1, -0.1, 0.5, -0.5, 0.9, 2.0, 5.0, 10.0];
                    const tol = 1e-6;
                    const maxIter = 50;

                    for (let guess of guesses) {
                        let rate = guess;
                        for (let i = 0; i < maxIter; i++) {
                            let fValue = 0;
                            let fDerivative = 0;
                            for (const t of transactions) {
                                const days = (t.dateObj - transactions[0].dateObj) / (1000 * 60 * 60 * 24);
                                const factor = Math.pow(1 + rate, days / 365);
                                if (factor === 0) continue;
                                fValue += t.amount / factor;
                                fDerivative -= (days / 365) * t.amount / (factor * (1 + rate));
                            }

                            if (Math.abs(fValue) < tol) return rate * 100;
                            if (Math.abs(fDerivative) < 1e-9) break;

                            const newRate = rate - fValue / fDerivative;
                            if (Math.abs(newRate - rate) < tol) return newRate * 100;

                            rate = newRate;
                            if (isNaN(rate) || Math.abs(rate) > 10000) break;
                            if (rate <= -1) rate = -0.99;
                        }
                    }

                    // Last Resort
                    const totalIn = transactions.filter(t => t.amount < 0).reduce((a, b) => a + b.amount, 0);
                    const totalOut = transactions.filter(t => t.amount > 0).reduce((a, b) => a + b.amount, 0);
                    const totalDays = (transactions[transactions.length - 1].dateObj - transactions[0].dateObj) / (1000 * 60 * 60 * 24);
                    if (Math.abs(totalIn) > 0 && totalDays > 0) {
                        const simpleRoi = (totalOut / Math.abs(totalIn)) - 1;
                        const simpleAnnual = Math.pow(1 + simpleRoi, 365 / totalDays) - 1;
                        return simpleAnnual * 100;
                    }

                    return 0;
                };

                // v3.7.5: Option B XIRR — 槓桿策略版
                // 起始值：總資產（淨資產 + 貸款）
                // 流量：入出金 + 借款(cashSynced=true 正流入) + 還款(cashSynced=true 負流出)
                // 終值：grandTotalAssets（總資產，不扣貸款）
                const computeSystemXirr = async () => {
                    if (!user.value || grandTotalAssets.value === 0) return;

                    try {
                        const historySnap = await db.collection('users').doc(user.value.uid).collection('history').orderBy('date', 'asc').limit(1).get();
                        if (historySnap.empty) { xirrValue.value = 0; xirrStartDate.value = '-'; return; }

                        const startData = historySnap.docs[0].data();
                        const startDate = startData.date;

                        // v3.7.5: 起始值改用「總資產」（淨資產 + 當時貸款）
                        let rawVal = startData.totalVal;
                        if (typeof rawVal === 'string') rawVal = rawVal.replace(/,/g, '');
                        const startNetWorth = Number(rawVal) || 0;
                        const startLoan = Number(startData.loan) || 0;
                        const startGrossAssets = startNetWorth + startLoan;

                        xirrStartDate.value = startDate;
                        xirrStartVal.value = formatCurrency(startGrossAssets, 'TWD');
                        xirrEndVal.value = formatCurrency(grandTotalAssets.value, 'TWD');

                        const txSnap = await db.collection('users').doc(user.value.uid).collection('transactions')
                            .where('date', '>', startDate)
                            .get();

                        const flows = [];
                        // 起始：投入總資產（負值）
                        flows.push({ amount: -Math.abs(startGrossAssets), dateObj: parseDate(startDate) });

                        txSnap.docs.forEach(doc => {
                            const t = doc.data();
                            const twd = (currency) => currency === 'USD' ? t.totalAmount * exchangeRate.value : t.totalAmount;

                            if (t.type === 'deposit') {
                                // 個人入金 → 你的錢流出 → 負
                                flows.push({ amount: -Math.abs(twd(t.currency)), dateObj: parseDate(t.date) });
                            } else if (t.type === 'withdraw') {
                                // 個人出金 → 你的錢流回 → 正
                                flows.push({ amount: Math.abs(twd(t.currency)), dateObj: parseDate(t.date) });
                            } else if (t.type === 'borrow' && t.cashSynced === true) {
                                // v3.7.5: 借款入帳 → 資金流入總資產池 → 正
                                flows.push({ amount: Math.abs(twd(t.currency)), dateObj: parseDate(t.date) });
                            } else if (t.type === 'repay' && t.cashSynced === true) {
                                // v3.7.5: 還款出帳 → 資金流出總資產池 → 負
                                flows.push({ amount: -Math.abs(twd(t.currency)), dateObj: parseDate(t.date) });
                            }
                        });

                        // 終值：當前總資產（不扣貸款）
                        flows.push({ amount: grandTotalAssets.value, dateObj: new Date() });

                        xirrFlowCount.value = flows.length;

                        const result = calcXIRR(flows);
                        xirrValue.value = (typeof result === 'number') ? result.toFixed(2) : result;
                    } catch (e) {
                        console.error("XIRR Error:", e);
                        xirrValue.value = "Err";
                    }
                };

                // --- 新增：特定區間 XIRR ---
                const showCustomXirrModal = ref(false);
                const cxDays = ref(0);
                const cxStartDate = ref('');
                const cxEndDate = ref('');
                const cxRealStartDate = ref('');
                const cxRealEndDate = ref('');
                const cxStartGross = ref(0);
                const cxEndGross = ref(0);
                const cxInflow = ref(0);
                const cxOutflow = ref(0);
                const cxXirrValue = ref(null);
                const cxLoading = ref(false);

                const openCustomXirrModal = () => {
                    const d = new Date();
                    d.setMonth(d.getMonth() - 1); 
                    cxStartDate.value = d.toISOString().split('T')[0];
                    cxEndDate.value = getLocalDate();
                    cxXirrValue.value = null;
                    showCustomXirrModal.value = true;
                };

                const calculateCustomXirr = async () => {
                    if(!cxStartDate.value || !cxEndDate.value) return alert('請選擇完整的起訖日期！');
                    if(cxStartDate.value >= cxEndDate.value) return alert('開始日期必須早於結束日期！');
                    cxLoading.value = true;
                    try {
                        const startSnap = await db.collection('users').doc(user.value.uid).collection('history')
                            .where('date', '<=', cxStartDate.value)
                            .orderBy('date', 'desc').limit(1).get();
                            
                        let startBase = 0;
                        let realStartDate = cxStartDate.value;
                        if (!startSnap.empty) {
                            const d = startSnap.docs[0].data();
                            startBase = (Number(String(d.totalVal).replace(/,/g, '')) || 0) + (Number(d.loan) || 0);
                            realStartDate = d.date;
                        } else {
                            const firstSnap = await db.collection('users').doc(user.value.uid).collection('history')
                                .orderBy('date', 'asc').limit(1).get();
                            if(firstSnap.empty) { cxLoading.value = false; return alert('無歷史資料可計算'); }
                            const d = firstSnap.docs[0].data();
                            startBase = (Number(String(d.totalVal).replace(/,/g, '')) || 0) + (Number(d.loan) || 0);
                            realStartDate = d.date;
                            cxStartDate.value = realStartDate;
                        }
                        
                        cxStartGross.value = startBase;
                        cxRealStartDate.value = realStartDate;
                        cxDays.value = 0; // reset
                        
                        let endBase = 0;
                        let realEndDate = cxEndDate.value;
                        if(cxEndDate.value >= getLocalDate()) {
                            endBase = grandTotalAssets.value;
                            realEndDate = '今日即時';
                        } else {
                            const endSnap = await db.collection('users').doc(user.value.uid).collection('history')
                                .where('date', '<=', cxEndDate.value)
                                .orderBy('date', 'desc').limit(1).get();
                            if(!endSnap.empty) {
                                const d = endSnap.docs[0].data();
                                endBase = (Number(String(d.totalVal).replace(/,/g, '')) || 0) + (Number(d.loan) || 0);
                                realEndDate = d.date;
                            } else {
                                endBase = startBase;
                            }
                        }
                        cxEndGross.value = endBase;
                        cxRealEndDate.value = realEndDate;
                        // 計算實際天數
                        const startD = parseDate(realStartDate);
                        const endD = realEndDate === '今日即時' ? new Date() : parseDate(realEndDate);
                        cxDays.value = Math.round((endD - startD) / (1000 * 60 * 60 * 24));
                        
                        const txSnap = await db.collection('users').doc(user.value.uid).collection('transactions')
                            .where('date', '>', realStartDate)
                            .where('date', '<=', realEndDate === '今日即時' ? getLocalDate() : realEndDate)
                            .get();
                            
                        const flows = [];
                        flows.push({ amount: -Math.abs(startBase), dateObj: parseDate(realStartDate) });
                        
                        let tin = 0, tout = 0;
                        txSnap.docs.forEach(doc => {
                            const t = doc.data();
                            const twd = (currency) => currency === 'USD' ? t.totalAmount * exchangeRate.value : t.totalAmount;
                            if (t.type === 'deposit') {
                                tin += twd(t.currency);
                                flows.push({ amount: -Math.abs(twd(t.currency)), dateObj: parseDate(t.date) });
                            } else if (t.type === 'withdraw') {
                                tout += twd(t.currency);
                                flows.push({ amount: Math.abs(twd(t.currency)), dateObj: parseDate(t.date) });
                            } else if (t.type === 'borrow' && t.cashSynced === true) {
                                tin += twd(t.currency); 
                                flows.push({ amount: Math.abs(twd(t.currency)), dateObj: parseDate(t.date) });
                            } else if (t.type === 'repay' && t.cashSynced === true) {
                                tout += twd(t.currency);
                                flows.push({ amount: -Math.abs(twd(t.currency)), dateObj: parseDate(t.date) });
                            }
                        });
                        
                        cxInflow.value = tin;
                        cxOutflow.value = tout;
                        
                        const endDateParsed = realEndDate === '今日即時' ? new Date() : parseDate(realEndDate);
                        flows.push({ amount: endBase, dateObj: endDateParsed });
                        
                        const result = calcXIRR(flows);
                        cxXirrValue.value = (typeof result === 'number') ? result.toFixed(2) : result;
                        
                    } catch (e) {
                        console.error('Custom XIRR Error', e);
                        alert('計算發生錯誤，請稍後再試。');
                    }
                    cxLoading.value = false;
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
                    // 興櫃 (emerging)：MIS 與上市/上櫃端點都不含興櫃，需另抓 TPEx 興櫃當日行情。
                    // 興櫃沒有集中撮合收盤價，欄位名稱與上市櫃不同，故動態判斷欄位（並於首筆印出實際欄位供確認/微調）。
                    try {
                        const j = await (await fetch(CF_PROXY + encodeURIComponent('https://www.tpex.org.tw/openapi/v1/tpex_esb_latest_statistics'))).json();
                        if (Array.isArray(j) && j.length) {
                            if (!fetchTwSnapshotFromOpenApi._esbLogged) {
                                console.info('[TPEx 興櫃] 範例欄位 keys =', Object.keys(j[0]));
                                console.info('[TPEx 興櫃] 範例資料 =', j[0]);
                                fetchTwSnapshotFromOpenApi._esbLogged = true;
                            }
                            const pick = (o, keys) => { for (const k of keys) { if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; } return undefined; };
                            const findCodeLike = (o) => { for (const k of Object.keys(o)) { const v = String(o[k] ?? '').trim(); if (/^\d{4,6}[A-Z]?$/.test(v)) return v; } return undefined; };
                            j.forEach(s => {
                                const code = (pick(s, ['SecuritiesCompanyCode', 'Code', 'CompanyCode', 'StockNo', '證券代號', '股票代號']) || findCodeLike(s) || '').toString().trim();
                                const name = pick(s, ['CompanyName', 'Name', 'SecuritiesCompanyName', '公司名稱', '證券名稱']);
                                const rawPrice = pick(s, ['LatestPrice', 'LastPrice', 'WeightedAvgPrice', 'DealPrice', 'Close', 'ClosingPrice', 'AvgPrice', '成交均價', '加權平均價', '最後成交價', '收盤價']);
                                const rawChange = pick(s, ['Change', 'PriceChange', '漲跌', '漲跌價差']);
                                const price = parseFloat(String(rawPrice ?? '').replace(/[,\s]/g, ''));
                                const change = parseFloat(String(rawChange ?? '0').replace(/[^-\d.]/g, '') || '0');
                                // 不覆蓋已存在的上市/上櫃代號；興櫃無撮合收盤價，找不到價就略過（讓上層維持失敗而非顯示昨收）
                                if (code && !map.has(code) && !isNaN(price) && price > 0)
                                    map.set(code, { price, prevClose: isNaN(change) ? price : price - change, market: 'emg', name });
                            });
                        }
                    } catch (e) { console.warn('[TPEx 興櫃] 失敗', e); }
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
                                    // 只接受成交價(z)或盤後定價(pz)；不再把昨收(s.y)當現價，
                                    // 否則無成交時會「現價=昨收、漲跌=0」並掩蓋抓取失敗，讓上層無法降級。
                                    if (price === '-' || price === '') price = (s.pz !== '-' && s.pz !== '') ? s.pz : '';
                                    const finalPrice = parseFloat(price);
                                    const prevClose = parseFloat(s.y);
                                    const market = s.ex === 'otc' ? 'otc' : 'tse';
                                    if (!isNaN(finalPrice) && finalPrice > 0)
                                        map.set(s.c, { price: finalPrice, prevClose: isNaN(prevClose) ? finalPrice : prevClose, market });
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

                const fetchTwStockPrice = async (symbol) => {
                    const cleanSym = symbol.replace(/\.(TW|TWO)$/i, '');

                    // 1. 先看 MIS 的快取 (有效期間只有 30 秒，通常在 batch更新時生成)
                    if (Date.now() - _twMisCacheTs < 30 * 1000) {
                        if (_twMisCache.has(cleanSym)) {
                            const d = _twMisCache.get(cleanSym);
                            return { regularMarketPrice: d.price, previousClose: d.prevClose };
                        } else {
                            // 批次快取中沒有此檔股票，直接退回 Open API（避免對未能成功抓取的股票狂發單獨請求）
                            const openApiMap = await fetchTwMarketSnapshot();
                            const d = openApiMap.get(cleanSym);
                            if (d) return { regularMarketPrice: d.price, previousClose: d.prevClose };
                            return null;
                        }
                    }

                    // 2. 獨立抓取單一檔 (透過 MIS，需要市場類別前綴)
                    const openApiMap = await fetchTwMarketSnapshot();
                    const openApiData = openApiMap.get(cleanSym);
                    const market = openApiData ? openApiData.market : 'tse'; // 預設 tse

                    const misMap = await fetchMisTwse([`${market}_${cleanSym}.tw`]);
                    const misData = misMap.get(cleanSym);

                    if (misData) {
                        return { regularMarketPrice: misData.price, previousClose: misData.prevClose };
                    }

                    // 3. 備用：退回到 Open API
                    if (openApiData) {
                        return { regularMarketPrice: openApiData.price, previousClose: openApiData.prevClose };
                    }

                    return null;
                };

                // ★★★ v4.3.0: 台股單支更新改走 Yahoo Finance（較 MIS 穩定）★★★
                // v7/finance/quote 已需 cookie/crumb 驗證、無 cookie 會回 401 Unauthorized，
                // 改用目前仍可匿名存取的 v8/finance/chart；失敗自動降級回 MIS → Open API
                const fetchTwStockPriceYahoo = async (stock) => {
                    const cleanSym = stock.symbol.replace(/\.(TW|TWO)$/i, '');
                    // 依 marketType 決定 Yahoo suffix（.TWO = 上櫃/興櫃, .TW = 上市）
                    const suffix = (stock.marketType === 'otc' || stock.marketType === 'emg') ? '.TWO' : '.TW';
                    const yahooSym = `${cleanSym}${suffix}`;
                    try {
                        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1d&range=1d`;
                        const resp = await fetchWithRetry(CF_PROXY + encodeURIComponent(url), 1, 8000);
                        const json = await resp.json();
                        const meta = json?.chart?.result?.[0]?.meta;
                        if (meta && meta.regularMarketPrice > 0) {
                            return {
                                regularMarketPrice: meta.regularMarketPrice,
                                previousClose: meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice
                            };
                        }
                    } catch (e) {
                        console.warn(`[Yahoo] ${yahooSym} 失敗，降級至 MIS/OpenAPI`, e);
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
                    for (let attempt = 0; attempt <= 1; attempt++) {
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
                    }
                    return null;
                };

                // 一次性偵測上市/上櫃/興櫃 (用 Open API 快照偵測，不走 proxy)
                const detectMarketType = async (stock) => {
                    if (stock.currency === 'USD') return 'us';
                    const cleanSym = stock.symbol.replace(/\.(TW|TWO)$/i, '');
                    const map = await fetchTwMarketSnapshot();
                    const d = map.get(cleanSym);
                    if (d) return d.market; // 'tse' / 'otc' / 'emg'
                    return null; // 快照查不到（如剛掛牌）：回 null 不硬猜，保留下次重新偵測機會
                };


                // 啟動時為未分類股票批次自動偵測（背景執行，不阻塞 UI）
                const autoDetectMarketTypes = async (unclassified) => {
                    if (!user.value || unclassified.length === 0) return;
                    console.log(`[v3.6.0] 自動偵測 ${unclassified.length} 支股票的上市/上櫃/興櫃屬性...`);
                    for (const stock of unclassified) {
                        try {
                            const marketType = await detectMarketType(stock);
                            if (!marketType) { console.warn(`[偵測] ${stock.symbol} 快照查無，暫不寫入，下次再試`); continue; }
                            await db.collection('users').doc(user.value.uid).collection('stocks').doc(stock.id).update({ marketType });
                            console.log(`[偵測] ${stock.symbol} → ${marketType}`);
                        } catch (e) { console.warn(`[偵測失敗] ${stock.symbol}`, e); }
                        await new Promise(r => setTimeout(r, 600));
                    }
                    console.log('[v3.6.0] 偵測完成！');
                };

                // v3.8.0: 統一的股價抓取入口
                const fetchStockData = async (stock) => {
                    let mt = stock.marketType;
                    // marketType 缺失時，fallback 用 currency 判斷（新增股票可能沒有 marketType）
                    const isUs = mt === 'us' || (!mt && stock.currency === 'USD');
                    if (isUs) {
                        return await fetchUsStockPrice(stock.symbol);
                    } else {
                        // 台股：Open API 自動分辨上市/上櫃
                        return await fetchTwStockPrice(stock.symbol);
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
                            const suffix = (d.market === 'otc' || d.market === 'emg') ? 'TWO' : 'TW';
                            // 興櫃 MIS 查不到，直接用快照；上市/上櫃才嘗試 MIS 即時報價
                            if (d.market !== 'emg') {
                                const misMap = await fetchMisTwse([`${d.market}_${cleanSym}.tw`]);
                                const misData = misMap.get(cleanSym);
                                if (misData) {
                                    return {
                                        symbol: `${cleanSym}.${suffix}`,
                                        name: d.name,
                                        regularMarketPrice: misData.price,
                                        previousClose: misData.prevClose
                                    };
                                }
                            }
                            // 退回到 Open API 快照
                            return {
                                symbol: `${cleanSym}.${suffix}`,
                                name: d.name,
                                regularMarketPrice: d.price,
                                previousClose: d.prevClose
                            };
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
                        console.warn('匯率更新失敗，將没用舊匯率', e);
                    }

                    // =========================================================
                    // 第二步：台股先批次預載快照（盤中走 MIS 即時，支援 40 筆分塊）
                    // =========================================================
                    if (marketType === 'TW') {
                        // 每支股票同時送 tse + otc 兩個前綴，讓 MIS 自動回傳對的那個
                        // 避免因為 marketType 記錯導致找不到股票
                        const exChList = targetStocks.flatMap(stock => {
                            const clean = stock.symbol.replace(/\.(TW|TWO)$/i, '');
                            if (stock.marketType === 'emg') return [];   // 興櫃 MIS 查不到，靠 Open API 快照
                            if (stock.marketType === 'otc') return [`otc_${clean}.tw`];
                            if (stock.marketType === 'tse') return [`tse_${clean}.tw`];
                            return [`tse_${clean}.tw`, `otc_${clean}.tw`]; // 未知：兩個都試
                        });
                        _twMisCache = await fetchMisTwse(exChList);
                        _twMisCacheTs = Date.now();
                        console.log(`[v3.8.1] 批次預載 MIS 報價，共 ${_twMisCache.size} 支`);
                    }


                    // =========================================================
                    // 第三步：開始更新股票迴圈
                    // =========================================================
                    const batch = db.batch();
                    let hasUpdates = false;
                    let successCount = 0;
                    let failCount = 0;

                    // 台股：快照已預載，迴圈純 lookup（可大並行）；美股：Finnhub 60 req/min
                    const CONCURRENT_LIMIT = marketType === 'US' ? 3 : 10;
                    const BATCH_DELAY = marketType === 'US' ? 3050 : 0;

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
                    lastUpdatedTs.value = now.getTime();

                    // 更新結束，重置按鈕狀態
                    loadingTarget.value = null;

                    const typeName = marketType === 'TW' ? '台股' : (marketType === 'US' ? '美股' : '全部');
                    alert(`${typeName} 更新完成！\n\n✅ 成功: ${successCount} 筆\n❌ 失敗: ${failCount} 筆`);
                };
                // [v4.3.0] 單一股票更新：台股優先走 Yahoo Finance，失敗降級至 MIS→OpenAPI
                const updateSingleStock = async (stock) => {
                    if (!user.value) return;

                    stockStates.value[stock.id] = 'loading';

                    try {
                        const isUs = stock.marketType === 'us' || (!stock.marketType && stock.currency === 'USD');
                        let data = null;

                        if (!isUs) {
                            // 台股：Yahoo Finance 優先
                            data = await fetchTwStockPriceYahoo(stock);
                            if (!data) {
                                console.log(`[updateSingleStock] ${stock.symbol} Yahoo 無資料，降級至 MIS`);
                                data = await fetchStockData(stock);
                            }
                        } else {
                            // 美股：Finnhub（不變）
                            data = await fetchStockData(stock);
                        }

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
                        console.error(e);
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
                const getAmountClass = (tx) => { if (tx.type === 'buy' || tx.type === 'withdraw' || tx.type === 'repay') return ''; if (tx.type === 'sell' || tx.type === 'dividend' || tx.type === 'deposit' || tx.type === 'borrow') return isDarkMode.value ? 'text-yellow-400' : 'text-yellow-600'; return ''; };
                // getAmountSign imported from utils


                return {
                    clearAllUserData, 
                    user, login, logout, stocks, exchangeRate, lastUpdated, isLoading, viewMode, isMobile, showPrivacy, isDarkMode, toggleDarkMode, activeSection, toggleSection, showChangelog, hideZeroShares, defaultPrivacyHidden,
                    twStats, usStats, grandTotalValue, grandTotalAssets, grandTotalExposure, grandTotalPnL, twStockList, usStockList, leverageRatio, exposureRatio,
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
                    loanList, totalLoanBalance, showLoanMgrModal, loanForm, openLoanMgrModal, editLoanAccount, saveLoanAccount, deleteLoanAccount, openLoanModal, isLoanMode, loanCashMode,
                    inlineNewLoan, inlineLoanName, saveInlineLoanAccount,
                    exportToExcel,
                    showSettingsModal, saveSettings,
                    triggerImport, fileInput, handleImport,
                    driveLoading, exportDataToDrive, importFromDrive,
                    setChartRange, currentRange, historyFilterYear, availableYears,
                    openStockNoteModal, showStockNoteModal, stockNoteForm, saveStockNote,
                    xirrValue, xirrStartDate, computeSystemXirr, xirrStartVal, xirrEndVal, xirrFlowCount,
                    updateSingleStock, stockStates, loadingTarget,
                    isPriceStale, lastUpdatedTs,
                    fetchStockData, detectMarketType, autoDetectMarketTypes,
                    sectionLoading,
                    showEditTxModal, editTxForm, openEditTxModal, saveEditTx,
                    realEstateList, realEstateTotalMarket, realEstateTotalMortgage, realEstateNetValue, realEstateBookPnL,
                    showRealEstateModal, realEstateForm, openRealEstateModal, saveRealEstate, deleteRealEstate,
                    getLoanName, getReMortgageTotal, getReMortgageLoans, toggleReMortgageLoan,
                    showCustomXirrModal, openCustomXirrModal, calculateCustomXirr,
                    cxStartDate, cxEndDate, cxLoading, cxXirrValue, cxDays,
                    cxRealStartDate, cxRealEndDate, cxStartGross, cxEndGross, cxInflow, cxOutflow,
                    monthlyProfitData, monthlyProfitRange, drawMonthlyChart
                };
            }
        }).mount('#app');
    
