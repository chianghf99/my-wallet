import pdfplumber
import re
import os
import requests
import time
import logging
import sys
import json
import traceback
from datetime import datetime
from send2trash import send2trash

# 🔇 關閉紅色警告
logging.getLogger("pdfminer").setLevel(logging.ERROR)

# ========= 🟢 設定路徑 =========
if getattr(sys, 'frozen', False):
    current_folder = os.path.dirname(sys.executable)
else:
    current_folder = os.path.dirname(os.path.abspath(__file__))

config_path = os.path.join(current_folder, "config.json")

def clean_string(s):
    if not s: return ""
    return ''.join([c for c in str(s) if 32 <= ord(c) < 127]).strip()

def load_config():
    if not os.path.exists(config_path):
        print(f"❌ 錯誤：找不到設定檔\n路徑：{config_path}")
        input("按 Enter 離開...")
        sys.exit(1)
    try:
        with open(config_path, 'r', encoding='utf-8-sig') as f:
            return json.load(f)
    except Exception as e:
        print(f"❌ 設定檔格式錯誤: {e}")
        input("按 Enter 離開...")
        sys.exit(1)

try:
    raw_config = load_config()
    BIN_ID = clean_string(raw_config.get("bin_id"))
    API_KEY = clean_string(raw_config.get("api_key"))
    PASSWORDS = raw_config.get("passwords", {})
    print(f"✅ 設定檔載入成功！")
except Exception as e:
    print(f"❌ 初始化失敗: {e}")
    sys.exit(1)

# ========================================

def move_to_trash(file_path):
    try:
        print(f"🗑️ 正在將檔案移至垃圾桶...")
        if os.path.exists(file_path):
            send2trash(file_path)
            print("✅ 檔案已移除 (垃圾桶)")
        else:
            print("⚠️ 檔案好像已經不見了？")
    except Exception as e:
        print(f"⚠️ 無法移動檔案 (可能被佔用): {e}")

def create_local_backup(data):
    try:
        backup_folder = os.path.join(current_folder, "backups")
        if not os.path.exists(backup_folder):
            os.makedirs(backup_folder)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_file = os.path.join(backup_folder, f"backup_{timestamp}.json")
        with open(backup_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=4)
        print(f"💾 已建立本機備份：{backup_file}")
    except Exception as e:
        print(f"⚠️ 備份失敗 (不影響上傳)：{e}")

def upload_to_cloud(card_name, amount, date, file_path):
    print(f"☁️ 準備上傳 {card_name} (${amount})...")
    if not API_KEY or not BIN_ID:
        print("❌ 錯誤：API Key 或 Bin ID 為空")
        return

    url = f"https://api.jsonbin.io/v3/b/{BIN_ID}"
    headers = {"Content-Type": "application/json", "X-Master-Key": API_KEY}

    try:
        res = requests.get(url + "/latest", headers=headers)
        if res.status_code != 200: 
            print(f"❌ 連線失敗 (讀取): {res.status_code}\n原因: {res.text}")
            return
        full_record = res.json().get("record", {})
        create_local_backup(full_record)

        if "bills" not in full_record: full_record["bills"] = []
        bills = full_record["bills"]
        for b in bills:
            if b.get("name") == card_name and str(b.get("amount")) == str(amount) and b.get("date") == date:
                print("⚠️ 已上傳過，跳過。")
                move_to_trash(file_path)
                return

        new_bill = {
            "id": int(time.time() * 1000),
            "name": card_name,
            "amount": amount,
            "date": date,
            "status": "unpaid"
        }
        bills.append(new_bill)
        
        res_put = requests.put(url, headers=headers, json=full_record)
        if res_put.status_code == 200:
            print(f"✅ 上傳成功！")
            move_to_trash(file_path)
        else:
            print(f"❌ 上傳失敗 (寫入): {res_put.status_code}\n原因: {res_put.text}")
    except Exception as e:
        print(f"連線錯誤：{e}")

def clean_date(date_str):
    try:
        date_str = date_str.replace(" ", "").replace("\n", "")
        # v3.13 修正：處理 "115 01 1" 這種只有空格的日期
        if "/" not in date_str and "-" not in date_str:
            # 嘗試把 "1150101" 這種格式處理一下
            date_str = re.sub(r"[^\d]", "", date_str) # 只留數字
            if len(date_str) >= 6:
                # 假設前3碼是年，中間2碼月，後面日
                y = int(date_str[:3]) + 1911
                m = date_str[3:5]
                d = date_str[5:].zfill(2)
                return f"{y}-{m}-{d}"
        
        date_str = re.sub(r"[^\d/-]", "", date_str)
        parts = re.split(r'[/-]', date_str)
        if len(parts) == 3:
            year = int(parts[0])
            if year < 1911: year += 1911
            return f"{year}-{parts[1].zfill(2)}-{parts[2].zfill(2)}"
        return date_str
    except: return date_str

# --- 銀行邏輯區 ---

def process_dbs(pdf_path):
    filename = os.path.basename(pdf_path)
    print(f"🤖 啟動 [星展銀行] 解析模式... ({filename})")
    amount = -1
    due_date = "未知日期"
    try:
        with pdfplumber.open(pdf_path, password=PASSWORDS.get("dbs")) as pdf:
            text = pdf.pages[0].extract_text()
            all_dates = re.findall(r"(\d{4}/\d{2}/\d{2})", text)
            if all_dates:
                valid_dates = [d for d in all_dates if "202" in d] 
                if valid_dates: due_date = clean_date(max(valid_dates))
            auto_pay_match = re.search(r"自動扣繳\s*(\d{1,3}(?:,\d{3})*)", text)
            if auto_pay_match: amount = int(auto_pay_match.group(1).replace(",", ""))
            if amount == -1:
                lines = text.split('\n')
                for line in lines:
                    nums = re.findall(r"(\d{1,3}(?:,\d{3})*)", line)
                    if len(nums) >= 3:
                        clean_nums = []
                        for n in nums:
                            try: clean_nums.append(int(n.replace(",", "")))
                            except: pass
                        valid_nums = [n for n in clean_nums if 0 < n < 200000]
                        if valid_nums: amount = max(valid_nums)
    except Exception as e:
        print(f"❌ 星展錯誤：{e}")
        return
    if amount > 0: upload_to_cloud("星展信用卡", amount, due_date, pdf_path)
    else: print("❌ 找不到星展金額")

def process_fubon_loan(pdf_path):
    filename = os.path.basename(pdf_path)
    print(f"🤖 啟動 [富邦學貸] 解析模式... ({filename})")
    amount = -1
    due_date = "未知日期"
    try:
        with pdfplumber.open(pdf_path, password=PASSWORDS.get("fubon")) as pdf:
            text = pdf.pages[0].extract_text()
            amt_match = re.search(r"本期應繳總金額\s*(\d{1,3}(?:,\d{3})*)", text)
            if amt_match: amount = int(amt_match.group(1).replace(",", ""))
            date_match = re.search(r"扣繳日期.*?(\d{3}/\d{2}/\d{2})", text, re.DOTALL)
            if not date_match:
                all_dates = re.findall(r"(\d{3}/\d{2}/\d{2})", text)
                if all_dates:
                    valid_dates = [d for d in all_dates if "11" in d]
                    if valid_dates: due_date = clean_date(max(valid_dates))
            else: due_date = clean_date(date_match.group(1))
    except Exception as e:
        print(f"❌ 富邦學貸錯誤：{e}")
        return
    if amount > 0: upload_to_cloud("富邦學貸", amount, due_date, pdf_path)
    else: print("❌ 找不到學貸金額")

def process_fubon(pdf_path):
    filename = os.path.basename(pdf_path)
    print(f"🤖 啟動 [富邦信用卡] 解析模式... ({filename})")
    amount = -1
    due_date = "未知日期"
    try:
        with pdfplumber.open(pdf_path, password=PASSWORDS.get("fubon")) as pdf:
            text = pdf.pages[0].extract_text()
            two_dates_match = re.search(r"(\d{3}/\d{2}/\d{2})\s+(\d{3}/\d{2}/\d{2})", text)
            if two_dates_match: due_date = clean_date(two_dates_match.group(2))
            else:
                date_match = re.search(r"繳款截止日\s*(\d{2,3}/\d{2}/\d{2})", text)
                if date_match: due_date = clean_date(date_match.group(1))
            text_nospace = text.replace(" ", "") 
            amt_match_cht = re.search(r"本期應繳總額(\d{1,3}(?:,\d{3})*)", text_nospace)
            if amt_match_cht: amount = int(amt_match_cht.group(1).replace(",", ""))
            else:
                amt_match_nt = re.search(r"NT\$(\d{1,3}(?:,\d{3})*)", text_nospace)
                if amt_match_nt: amount = int(amt_match_nt.group(1).replace(",", ""))
    except Exception as e:
        print(f"❌ 富邦錯誤：{e}")
        return
    if amount > 0: upload_to_cloud("富邦信用卡", amount, due_date, pdf_path)
    else: print("❌ 找不到富邦金額")

def process_cathay(pdf_path):
    filename = os.path.basename(pdf_path)
    print(f"🤖 啟動 [國泰世華] 解析模式... ({filename})")
    amount = -1
    due_date = "未知日期"
    try:
        with pdfplumber.open(pdf_path, password=PASSWORDS.get("cathay")) as pdf:
            page = pdf.pages[0]
            text = page.extract_text()
            lines = [line.strip() for line in text.split('\n')]
            
            # 優先使用更精準的單獨日期對齊法（取最晚日期 = 截止日，而非結帳日）
            standalone_dates = []
            for idx, line in enumerate(lines):
                if re.match(r"^\d{3,4}/\d{2}/\d{2}$", line):
                    standalone_dates.append((idx, line, clean_date(line)))
            
            if standalone_dates:
                # 取 ISO 最大的那個日期 = 截止日
                latest = max(standalone_dates, key=lambda x: x[2])
                due_date = latest[2]
                # 往後幾行找第一個非整萬、合理範圍的金額
                for j in range(latest[0] + 1, min(latest[0] + 12, len(lines))):
                    amt_line_clean = re.sub(r"\(cid:\d+\)", "", lines[j]).strip()
                    nums = re.findall(r"\d{1,3}(?:,\d{3})*", amt_line_clean)
                    for n in nums:
                        val = int(n.replace(",", ""))
                        if 100 <= val < 150000 and val % 10000 != 0:
                            amount = val
                            break
                    if amount > 0:
                        break
            
            # 如果解析失敗，使用原有的備份邏輯
            if amount <= 0 or due_date == "未知日期":
                print("⚠️ 單獨日期法失敗，啟用原有佈局解析邏輯...")
                if "繳款截止日" in text:
                    date_match = re.search(r"繳款截止日.*?(\d{3,4}/\d{1,2}/\d{1,2})", text)
                    if date_match: due_date = clean_date(date_match.group(1))
                if due_date == "未知日期":
                    all_dates = re.findall(r"(\d{3}/\d{2}/\d{2})", text)
                    if not all_dates: all_dates = re.findall(r"(\d{4}/\d{2}/\d{2})", text)
                    if all_dates:
                        converted_dates = [clean_date(d) for d in all_dates]
                        due_date = max(converted_dates)
                words = page.extract_words()
                lines_dict = {} 
                for word in words:
                    text_val = word['text']
                    if "," in text_val and re.match(r"^\d{1,3}(,\d{3})*$", text_val):
                        val = int(text_val.replace(",", ""))
                        top = int(word['top']) 
                        found_key = None
                        for k in lines_dict.keys():
                            if abs(k - top) < 5:
                                found_key = k
                                break
                        if found_key is not None: lines_dict[found_key].append(val)
                        else: lines_dict[top] = [val]
                final_candidates = []
                for top, numbers in lines_dict.items():
                    if len(numbers) > 2: continue 
                    has_huge_limit = any(n > 150000 for n in numbers)
                    if has_huge_limit:
                        bills = [n for n in numbers if n < 150000]
                        if bills:
                            amount = max(bills)
                            break 
                    for n in numbers:
                        if n < 150000: final_candidates.append(n)
                if amount == -1 and final_candidates:
                    non_thousand = [x for x in final_candidates if x != 1000]
                    if non_thousand:
                        non_round_limit = [x for x in non_thousand if x % 10000 != 0]
                        if non_round_limit: amount = max(non_round_limit) 
                        else: amount = max(non_thousand) 
                    else: amount = max(final_candidates) 
    except Exception as e:
        print(f"❌ 國泰錯誤：{e}")
        return
    if amount > 0: upload_to_cloud("國泰信用卡", amount, due_date, pdf_path)
    else: print("❌ 找不到國泰金額")

def process_shinkong(pdf_path):
    filename = os.path.basename(pdf_path)
    print(f"🤖 啟動 [新光銀行] 解析模式... ({filename})")
    amount = -1
    due_date = "未知日期"
    try:
        with pdfplumber.open(pdf_path, password=PASSWORDS.get("shinkong")) as pdf:
            text = pdf.pages[0].extract_text()
            text_nospace = text.replace(" ", "")
            
            date_match = re.search(r"繳款截止日(\d{2,3}/\d{2}/\d{2})", text_nospace)
            if date_match:
                due_date = clean_date(date_match.group(1))
                
            amt_match = re.search(r"本期應繳總金額(\d{1,3}(?:,\d{3})*)", text_nospace)
            if amt_match:
                amount = int(amt_match.group(1).replace(",", ""))
    except Exception as e:
        print(f"❌ 新光錯誤：{e}")
        return
    if amount > 0: upload_to_cloud("新光信用卡", amount, due_date, pdf_path)
    else: print("❌ 找不到新光金額")

def process_taishin(pdf_path):
    filename = os.path.basename(pdf_path)
    print(f"🤖 啟動 [台新] 解析模式... ({filename})")
    amount = -1
    due_date = "未知日期"
    try:
        with pdfplumber.open(pdf_path, password=PASSWORDS.get("taishin")) as pdf:
            text = pdf.pages[0].extract_text()
            date_match = re.search(r"繳款截止日\s*(\d{2,3}/\d{2}/\d{2})", text)
            if date_match: due_date = clean_date(date_match.group(1))
            amt_match = re.search(r"本期累計應繳金額\s*(\d{1,3}(?:,\d{3})*|0)", text)
            if amt_match: amount = int(amt_match.group(1).replace(",", ""))
    except Exception as e:
        print(f"❌ 台新錯誤：{e}")
        return
    if amount >= 0:
        upload_to_cloud("台新信用卡", amount, due_date, pdf_path)
        if amount == 0:
            print("🎉 台新金額為 0，無需繳款。")
            move_to_trash(pdf_path)
    else: print("❌ 找不到台新金額")

def process_sinopac(pdf_path):
    filename = os.path.basename(pdf_path)
    print(f"🤖 啟動 [永豐] 解析模式... ({filename})")
    amount = -1
    due_date = "未知日期"
    try:
        with pdfplumber.open(pdf_path, password=PASSWORDS.get("sinopac")) as pdf:
            text = pdf.pages[0].extract_text()
            date_match = re.search(r"截止日\s*[:]?\s*(\d{4}/\d{2}/\d{2})", text)
            if date_match: due_date = clean_date(date_match.group(1))
            deduct_match = re.search(r"預定扣款金額\s*(\d{1,3}(?:,\d{3})*)", text)
            if deduct_match: amount = int(deduct_match.group(1).replace(",", ""))
            if amount == -1:
                amt_match = re.search(r"(?<!上期)應繳總金額\s*(\d{1,3}(?:,\d{3})*)", text)
                if amt_match: amount = int(amt_match.group(1).replace(",", ""))
            if amount == -1:
                tables = pdf.pages[0].extract_tables()
                for table in tables:
                    for row in table:
                        c_row = [str(c).replace("\n","").replace(" ","") for c in row if c]
                        if "臺幣" in c_row and len(row) > 6:
                            try: amount = int(row[6].replace(",", "").strip())
                            except: continue
    except Exception as e:
        print(f"❌ 永豐錯誤：{e}")
        return
    if amount > 0: upload_to_cloud("永豐信用卡", amount, due_date, pdf_path)
    else: print("❌ 找不到永豐金額")

def process_chb(pdf_path):
    filename = os.path.basename(pdf_path)
    print(f"🤖 啟動 [彰化銀行] 解析模式... ({filename})")
    amount = -1
    due_date = "未知日期"
    try:
        with pdfplumber.open(pdf_path, password=PASSWORDS.get("chb")) as pdf:
            text = pdf.pages[0].extract_text()
            date_match = re.search(r"截止日[\s\S]{0,30}(\d{4}/\d{2}/\d{2})", text)
            if date_match: due_date = clean_date(date_match.group(1))
            else:
                all_dates = re.findall(r"(\d{4}/\d{2}/\d{2})", text)
                if all_dates: due_date = clean_date(max(all_dates))
            amt_match = re.search(r"本期應繳總額.*?[=]\s*(\d{1,3}(?:,\d{3})*)", text, re.DOTALL)
            if not amt_match: amt_match = re.search(r"[=]\s*(\d{1,3}(?:,\d{3})*)", text)
            if amt_match: amount = int(amt_match.group(1).replace(",", ""))
    except Exception as e:
        print(f"❌ 彰銀錯誤：{e}")
        return
    if amount > 0: upload_to_cloud("彰銀信用卡", amount, due_date, pdf_path)
    else: print("❌ 找不到彰銀金額")

def process_esun(pdf_path):
    filename = os.path.basename(pdf_path)
    print(f"🤖 啟動 [玉山銀行] 解析模式... ({filename})")
    amount = -1
    due_date = "未知日期"
    try:
        with pdfplumber.open(pdf_path, password=PASSWORDS.get("esun")) as pdf:
            text = pdf.pages[0].extract_text()
            all_dates = re.findall(r"(\d{3}/\d{2}/\d{2})", text)
            if all_dates:
                converted_dates = [clean_date(d) for d in all_dates]
                due_date = max(converted_dates)
            text_nospace = text.replace(" ", "").replace("\n", "")
            pattern = r"(\d{1,3}(?:,\d{3})*)元(\d{1,3}(?:,\d{3})*)元"
            matches = re.search(pattern, text_nospace)
            if matches: amount = int(matches.group(1).replace(",", ""))
            if amount == -1:
                amt_match = re.search(r"本期應繳總金額(\d{1,3}(?:,\d{3})*)元", text_nospace)
                if not amt_match: amt_match = re.search(r"本期應繳總金額.*?(\d{1,3}(?:,\d{3})*)", text_nospace)
                if amt_match: amount = int(amt_match.group(1).replace(",", ""))
    except Exception as e:
        print(f"❌ 玉山錯誤：{e}")
        return
    if amount > 0: upload_to_cloud("玉山信用卡", amount, due_date, pdf_path)
    else: print("❌ 找不到玉山金額")

def process_ubot(pdf_path):
    filename = os.path.basename(pdf_path)
    print(f"🤖 啟動 [聯邦銀行] 解析模式... ({filename})")
    amount = -1
    due_date = "未知日期"
    try:
        with pdfplumber.open(pdf_path, password=PASSWORDS.get("ubot")) as pdf:
            text = pdf.pages[0].extract_text()
            amt_match = re.search(r"(\d{1,3}(?:,\d{3})*).*?優惠注意事項", text)
            if amt_match: amount = int(amt_match.group(1).replace(",", ""))
            all_dates_matches = re.finditer(r"(\d{3}/\d{2}/\d{2})", text)
            valid_dates = []
            for match in all_dates_matches:
                d_str = match.group(1)
                line_start = max(0, match.start() - 10)
                line_end = min(len(text), match.end() + 20)
                context = text[line_start:line_end]
                if "止" not in context and "適用期間" not in context:
                    valid_dates.append(clean_date(d_str))
            if valid_dates: due_date = max(valid_dates)
    except Exception as e:
        print(f"❌ 聯邦錯誤：{e}")
        return
    if amount > 0: upload_to_cloud("聯邦信用卡", amount, due_date, pdf_path)
    else: print("❌ 找不到聯邦金額")

def process_ctbc(pdf_path):
    filename = os.path.basename(pdf_path)
    print(f"🤖 啟動 [中國信託] 解析模式... ({filename})")
    amount = -1
    due_date = "未知日期"
    try:
        with pdfplumber.open(pdf_path, password=PASSWORDS.get("ctbc")) as pdf:
            full_text = ""
            for p in pdf.pages[:2]:
                full_text += p.extract_text() + "\n"
            
            # 1. 先抓日期 (因為中信的日期格式在亂碼狀態下也很亂)
            # 抓取文中最大的日期 (假設是截止日)
            all_dates = re.findall(r"(\d{3}\s\d{2}\s\d{2})|(\d{3}/\d{2}/\d{2})", full_text)
            valid_dates = []
            for d_tuple in all_dates:
                d_str = d_tuple[0] or d_tuple[1]
                # 簡單過濾一下，只抓 114, 115 年的
                if "114" in d_str or "115" in d_str:
                    valid_dates.append(clean_date(d_str))
            
            if valid_dates: due_date = max(valid_dates)

            # 2. 抓金額
            # 策略 A: 找 $
            matches = re.findall(r"\$\s*(\d{1,3}(?:,\d{3})*)", full_text)
            clean_nums = []
            for m in matches:
                try: clean_nums.append(int(m.replace(",", "")))
                except: pass
            if clean_nums: amount = max(clean_nums)

            # 策略 B: 找亂碼特徵 (v3.13 新增)
            # 如果還是找不到，且發現特徵 "/ 0/ 0" 或 "0 +0"，直接強制設為 0
            if amount == -1:
                if re.search(r"/\s*0/\s*0", full_text) or re.search(r"\s0\s+\+0", full_text):
                    amount = 0

    except Exception as e:
        print(f"❌ 中信錯誤：{e}")
        return
    
    if amount > 0: 
        upload_to_cloud("中信信用卡", amount, due_date, pdf_path)
    elif amount == 0:
        print("🎉 中信金額為 0，無需繳款。")
        move_to_trash(pdf_path)
    else: 
        print("❌ 找不到中信金額")

# ========= 🧠 主腦 =========
def main():
    print(f"📂 正在掃描資料夾：{current_folder}")
    files = [f for f in os.listdir(current_folder) if f.lower().endswith('.pdf')]
    if not files: print("📭 這裡沒有 PDF")
    
    for file in files:
        full_path = os.path.join(current_folder, file)
        filename_chk = file.lower()
        
        is_fubon_date = bool(re.match(r"^\d+年\d+月", file))

        # ✅ 分流判斷
        if "CBGCC" in file or "DBS" in file or "星展" in file: process_dbs(full_path)
        elif "就學貸款" in file: process_fubon_loan(full_path)
        elif "永豐" in file: process_sinopac(full_path)
        elif "富邦" in file or is_fubon_date: process_fubon(full_path)
        elif "tsb" in filename_chk or "台新" in file: process_taishin(full_path)
        elif "彰化" in file or "chb" in filename_chk: process_chb(full_path)
        elif "國泰" in file or "消費明細" in file: process_cathay(full_path)
        elif "玉山" in file or "esun" in filename_chk: process_esun(full_path)
        elif "ubot" in filename_chk or "聯邦" in file: process_ubot(full_path)
        elif "ctbc" in filename_chk or "中信" in file: process_ctbc(full_path)
        elif "新光" in file: process_shinkong(full_path)
        else:
            print(f"⚠️ 跳過未知檔案: {file} (請將銀行名稱加入檔名)")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n❌ 發生未預期的錯誤: {e}")
        traceback.print_exc()
    finally:
        print("\n" + "-" * 30)
        input("✅ 執行結束，請按 Enter 鍵關閉視窗...")