import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskText } from '../js/parser.js';

const TODAY = '2026-10-07';
const categories = [
  { id: 'c-work', name: '仕事', color: '#2563eb' },
  { id: 'c-logi', name: 'LOGIAXIS', color: '#7c3aed' },
  { id: 'c-private', name: '私用', color: '#16a34a' },
];

function parse(text, today = TODAY) {
  return parseTaskText(text, { categories, today });
}

function expectMatch(text, expected, today = TODAY) {
  const r = parse(text, today);
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'matched') {
      for (const [mk, mv] of Object.entries(value)) {
        assert.equal(r.matched[mk], mv, `${text}: matched.${mk}`);
      }
    } else {
      assert.equal(r[key], value, `${text}: ${key}`);
    }
  }
  return r;
}

const voiceCases = [
  ['あしたまでに請求書送付優先度高', {
    title: '請求書送付', due: '2026-10-08', priority: 'high', repeat: null, categoryId: null,
    matched: { due: 'あした', priority: '優先度高' },
  }],
  ['毎週金曜に週報を書く仕事', {
    title: '週報を書く', due: '2026-10-09', priority: null, repeat: 'weekly', categoryId: 'c-work',
    matched: { due: '金曜', repeat: '毎週', category: '仕事' },
  }],
  ['来週の水曜日までにLOGIAXISの提案書を作る至急', {
    title: '提案書を作る', due: '2026-10-14', priority: 'high', repeat: null, categoryId: 'c-logi',
    matched: { due: '来週の水曜日', priority: '至急', category: 'LOGIAXIS' },
  }],
  ['15日に家賃振込私用', {
    title: '家賃振込', due: '2026-10-15', priority: null, repeat: null, categoryId: 'c-private',
    matched: { due: '15日', category: '私用' },
  }],
  ['3月5日までに確定申告', {
    title: '確定申告', due: '2027-03-05', priority: null, repeat: null, categoryId: null,
    matched: { due: '3月5日' },
  }],
  ['今週中に見積もり', {
    title: '見積もり', due: '2026-10-11', priority: null, repeat: null, categoryId: null,
    matched: { due: '今週中' },
  }],
  ['月末までに請求書', {
    title: '請求書', due: '2026-10-31', priority: null, repeat: null, categoryId: null,
    matched: { due: '月末' },
  }],
  ['いつか本を読む', {
    title: '本を読む', due: null, priority: 'low', repeat: null, categoryId: null,
    matched: { priority: 'いつか' },
  }],
];

for (const [text, expected] of voiceCases) {
  test(`音声入力例: ${text}`, () => {
    expectMatch(text, expected);
  });
}

test('相対日付: 今日/本日', () => {
  expectMatch('今日請求書を送る', { title: '請求書を送る', due: '2026-10-07', matched: { due: '今日' } });
  expectMatch('本日中に入金確認', { title: '入金確認', due: '2026-10-07', matched: { due: '本日中' } });
});

test('相対日付: 明日/明後日/あさって', () => {
  expectMatch('明日会議資料', { title: '会議資料', due: '2026-10-08', matched: { due: '明日' } });
  expectMatch('明後日に打合せ', { title: '打合せ', due: '2026-10-09', matched: { due: '明後日' } });
  expectMatch('あさって歯医者', { title: '歯医者', due: '2026-10-09', matched: { due: 'あさって' } });
});

test('相対日付: 今週/来週/週末', () => {
  expectMatch('今週レポート', { title: 'レポート', due: '2026-10-11' });
  expectMatch('来週提案書', { title: '提案書', due: '2026-10-12', matched: { due: '来週' } });
  expectMatch('週末に掃除', { title: '掃除', due: '2026-10-10', matched: { due: '週末' } });
});

test('相対日付: 今月末/来月/来月末', () => {
  expectMatch('今月末までに経費精算', { title: '経費精算', due: '2026-10-31', matched: { due: '今月末' } });
  expectMatch('来月に契約更新', { title: '契約更新', due: '2026-11-01', matched: { due: '来月' } });
  expectMatch('来月末までに決算資料', { title: '決算資料', due: '2026-11-30', matched: { due: '来月末' } });
});

test('曜日: 次に来るその曜日（今日が該当なら今日）', () => {
  expectMatch('金曜までに資料', { title: '資料', due: '2026-10-09', matched: { due: '金曜' } });
  expectMatch('水曜日に定例', { title: '定例', due: '2026-10-07', matched: { due: '水曜日' } });
  expectMatch('月曜に報告', { title: '報告', due: '2026-10-12' });
  expectMatch('日曜日にジム', { title: 'ジム', due: '2026-10-11' });
});

test('曜日: 来週○曜 / 今週○曜 / 次の○曜', () => {
  expectMatch('来週金曜に納品', { title: '納品', due: '2026-10-16', matched: { due: '来週金曜' } });
  expectMatch('来週の月曜に出張', { title: '出張', due: '2026-10-12' });
  expectMatch('来週日曜に旅行', { title: '旅行', due: '2026-10-18' });
  expectMatch('今週の金曜日までにレビュー', { title: 'レビュー', due: '2026-10-09' });
  expectMatch('次の水曜に面談', { title: '面談', due: '2026-10-14' });
});

test('○日: 今月のその日が過去なら来月', () => {
  expectMatch('5日に支払い', { title: '支払い', due: '2026-11-05', matched: { due: '5日' } });
  expectMatch('7日に提出', { title: '提出', due: '2026-10-07' });
  expectMatch('31日に締め', { title: '締め', due: '2026-10-31' });
  expectMatch('20日までに振込', { title: '振込', due: '2026-10-20' });
});

test('○日: 存在しない日は翌月側で丸める', () => {
  expectMatch('31日に処理', { due: '2026-12-31' }, '2026-11-05');
});

test('○月○日: 過去の月日は来年扱い', () => {
  expectMatch('12月24日にパーティー', { title: 'パーティー', due: '2026-12-24' });
  expectMatch('10月7日に面接', { title: '面接', due: '2026-10-07' });
  expectMatch('1月10日までに年賀状', { title: '年賀状', due: '2027-01-10', matched: { due: '1月10日' } });
});

test('○/○ 形式（半角・全角）', () => {
  expectMatch('10/20に納品', { title: '納品', due: '2026-10-20', matched: { due: '10/20' } });
  expectMatch('１０／２０に納品', { title: '納品', due: '2026-10-20', matched: { due: '１０／２０' } });
  expectMatch('2/15までに申請', { title: '申請', due: '2027-02-15' });
});

test('漢数字・全角数字', () => {
  expectMatch('三月五日までに確定申告', { title: '確定申告', due: '2027-03-05', matched: { due: '三月五日' } });
  expectMatch('十二月二十四日に贈り物', { title: '贈り物', due: '2026-12-24' });
  expectMatch('二十日に振込', { title: '振込', due: '2026-10-20', matched: { due: '二十日' } });
  expectMatch('十五日に家賃', { title: '家賃', due: '2026-10-15' });
  expectMatch('三十一日に棚卸', { title: '棚卸', due: '2026-10-31' });
  expectMatch('１５日に家賃振込', { title: '家賃振込', due: '2026-10-15', matched: { due: '１５日' } });
});

test('○日後', () => {
  expectMatch('3日後に連絡', { title: '連絡', due: '2026-10-10', matched: { due: '3日後' } });
  expectMatch('十日後にフォロー', { title: 'フォロー', due: '2026-10-17' });
  expectMatch('１日後に確認', { title: '確認', due: '2026-10-08' });
});

test('来月○日 / 今月○日', () => {
  expectMatch('来月15日に家賃', { title: '家賃', due: '2026-11-15', matched: { due: '来月15日' } });
  expectMatch('今月の20日までに請求', { title: '請求', due: '2026-10-20' });
});

test('期限・締切の語尾と前置きを除去', () => {
  expectMatch('締切は明日資料提出', { title: '資料提出', due: '2026-10-08' });
  expectMatch('明日が締切の資料提出', { title: '資料提出', due: '2026-10-08' });
  expectMatch('期限3月5日確定申告', { title: '確定申告', due: '2027-03-05' });
});

test('優先度: high のキーワード', () => {
  expectMatch('至急請求書を送る', { title: '請求書を送る', priority: 'high', matched: { priority: '至急' } });
  expectMatch('大至急で電話', { title: '電話', priority: 'high', matched: { priority: '大至急' } });
  expectMatch('重要な契約書を確認', { title: '契約書を確認', priority: 'high', matched: { priority: '重要' } });
  expectMatch('急ぎで見積もり', { title: '見積もり', priority: 'high', matched: { priority: '急ぎ' } });
  expectMatch('最優先で修正', { title: '修正', priority: 'high', matched: { priority: '最優先' } });
  expectMatch('資料作成優先度高', { title: '資料作成', priority: 'high', matched: { priority: '優先度高' } });
  expectMatch('優先度は高い資料作成', { title: '資料作成', priority: 'high', matched: { priority: '優先度は高い' } });
});

test('優先度: low のキーワード', () => {
  expectMatch('あとで本棚整理', { title: '本棚整理', priority: 'low', matched: { priority: 'あとで' } });
  expectMatch('優先度低で机の整理', { title: '机の整理', priority: 'low', matched: { priority: '優先度低' } });
  expectMatch('そのうち写真整理', { title: '写真整理', priority: 'low' });
});

test('優先度: mid のキーワード', () => {
  expectMatch('優先度中で日報', { title: '日報', priority: 'mid', matched: { priority: '優先度中' } });
  expectMatch('普通で備品発注', { title: '備品発注', priority: 'mid', matched: { priority: '普通' } });
});

test('優先度: 単独の高/中/低は文末のみ採用', () => {
  expectMatch('資料作成高', { title: '資料作成', priority: 'high', matched: { priority: '高' } });
  expectMatch('資料作成 低', { title: '資料作成', priority: 'low', matched: { priority: '低' } });
  expectMatch('日報中です', { title: '日報', priority: 'mid' });
  expectMatch('明日までに資料作成高', { title: '資料作成', due: '2026-10-08', priority: 'high' });
});

test('優先度: 誤検知しない', () => {
  expectMatch('最高の提案書を作る', { title: '最高の提案書を作る', priority: null });
  expectMatch('中間報告を出す', { title: '中間報告を出す', priority: null });
  expectMatch('低コスト案を考える', { title: '低コスト案を考える', priority: null });
  expectMatch('高橋さんに電話', { title: '高橋さんに電話', priority: null });
});

test('繰り返し', () => {
  expectMatch('毎日ストレッチ', { title: 'ストレッチ', repeat: 'daily', due: null, matched: { repeat: '毎日' } });
  expectMatch('毎週の定例会議', { title: '定例会議', repeat: 'weekly', due: null });
  expectMatch('毎月15日に家賃振込', { title: '家賃振込', repeat: 'monthly', due: '2026-10-15', matched: { repeat: '毎月', due: '15日' } });
  expectMatch('デイリーで日報', { title: '日報', repeat: 'daily' });
  expectMatch('ウィークリーで振り返り', { title: '振り返り', repeat: 'weekly' });
  expectMatch('マンスリーで集計', { title: '集計', repeat: 'monthly', matched: { repeat: 'マンスリー' } });
});

test('繰り返し: 毎週○曜は weekly + 次の該当曜日', () => {
  expectMatch('毎週水曜に定例', { title: '定例', repeat: 'weekly', due: '2026-10-07' });
  expectMatch('毎週月曜日に週次会議', { title: '週次会議', repeat: 'weekly', due: '2026-10-12' });
});

test('カテゴリ: 最長一致と直後の助詞除去', () => {
  expectMatch('仕事の資料', { title: '資料', categoryId: 'c-work', matched: { category: '仕事' } });
  expectMatch('私用で買い物', { title: '買い物', categoryId: 'c-private', matched: { category: '私用' } });
  expectMatch('LOGIAXISの提案書', { title: '提案書', categoryId: 'c-logi' });
  expectMatch('logiaxisの提案書', { title: '提案書', categoryId: 'c-logi', matched: { category: 'logiaxis' } });
  const longer = [...categories, { id: 'c-work2', name: '仕事術', color: '#000000' }];
  const r = parseTaskText('仕事術の本を読む', { categories: longer, today: TODAY });
  assert.equal(r.categoryId, 'c-work2');
  assert.equal(r.title, '本を読む');
});

test('カテゴリ名が解析語と衝突しても優先される', () => {
  const cats = [{ id: 'c-diy', name: '日曜大工', color: '#000000' }];
  const r = parseTaskText('日曜大工の棚作り', { categories: cats, today: TODAY });
  assert.equal(r.categoryId, 'c-diy');
  assert.equal(r.due, null);
  assert.equal(r.title, '棚作り');
});

test('title が空になったら元テキストをそのまま使う', () => {
  expectMatch('明日', { title: '明日', due: '2026-10-08' });
  expectMatch('至急', { title: '至急', priority: 'high' });
  expectMatch('仕事', { title: '仕事', categoryId: 'c-work' });
});

test('解析語がなければ title はそのまま、他は null', () => {
  const r = parse('請求書を送る');
  assert.deepEqual(r, {
    title: '請求書を送る', due: null, time: null, priority: null, repeat: null, categoryId: null, matched: {},
  });
});

test('時刻: ○時（半角・全角・漢数字）', () => {
  expectMatch('9時に会議', { title: '会議', time: '09:00', due: null, matched: { time: '9時' } });
  expectMatch('９時に会議', { title: '会議', time: '09:00', matched: { time: '９時' } });
  expectMatch('九時に会議', { title: '会議', time: '09:00', matched: { time: '九時' } });
  expectMatch('十時に会議', { title: '会議', time: '10:00', matched: { time: '十時' } });
  expectMatch('二十一時に電話', { title: '電話', time: '21:00', matched: { time: '二十一時' } });
  expectMatch('21時にレポート提出', { title: 'レポート提出', time: '21:00', matched: { time: '21時' } });
});

test('時刻: ○時半 / ○時○分', () => {
  expectMatch('9時半から会議', { title: '会議', time: '09:30', matched: { time: '9時半' } });
  expectMatch('9時30分に会議', { title: '会議', time: '09:30', matched: { time: '9時30分' } });
  expectMatch('9時５分に会議', { title: '会議', time: '09:05', matched: { time: '9時５分' } });
  expectMatch('十時半に会議', { title: '会議', time: '10:30' });
  expectMatch('九時十五分に会議', { title: '会議', time: '09:15' });
});

test('時刻: コロン形式', () => {
  expectMatch('9:30に会議', { title: '会議', time: '09:30', matched: { time: '9:30' } });
  expectMatch('09:30に会議', { title: '会議', time: '09:30', matched: { time: '09:30' } });
  expectMatch('9：30に会議', { title: '会議', time: '09:30', matched: { time: '9：30' } });
  expectMatch('21:00にレポート提出', { title: 'レポート提出', time: '21:00', matched: { time: '21:00' } });
});

test('時刻: 午前・朝は加算しない', () => {
  expectMatch('朝の9時に 群馬銀行の返済予定表を確認', {
    title: '群馬銀行の返済予定表を確認', time: '09:00', due: null, matched: { time: '朝の9時' },
  });
  expectMatch('朝9時に会議', { title: '会議', time: '09:00', matched: { time: '朝9時' } });
  expectMatch('午前10時に面談', { title: '面談', time: '10:00', matched: { time: '午前10時' } });
  expectMatch('午前12時に昼食', { title: '昼食', time: '12:00' });
  expectMatch('今朝8時に体重測定', { title: '体重測定', time: '08:00', matched: { time: '今朝8時' } });
});

test('時刻: 午後・昼・夕方・夜・晩は12未満なら+12', () => {
  expectMatch('午後3時に打ち合わせ', { title: '打ち合わせ', time: '15:00', matched: { time: '午後3時' } });
  expectMatch('夜8時に電話', { title: '電話', time: '20:00', matched: { time: '夜8時' } });
  expectMatch('夜8時半に電話', { title: '電話', time: '20:30', matched: { time: '夜8時半' } });
  expectMatch('昼12時に昼食', { title: '昼食', time: '12:00', matched: { time: '昼12時' } });
  expectMatch('昼の1時に打合せ', { title: '打合せ', time: '13:00', matched: { time: '昼の1時' } });
  expectMatch('夕方5時頃に帰宅', { title: '帰宅', time: '17:00', matched: { time: '夕方5時' } });
  expectMatch('晩9時ごろ電話', { title: '電話', time: '21:00', matched: { time: '晩9時' } });
  expectMatch('夜の10時くらいに読書', { title: '読書', time: '22:00' });
  expectMatch('今夜8時に電話', { title: '電話', time: '20:00', due: null, matched: { time: '今夜8時' } });
  expectMatch('午後9時に電話', { title: '電話', time: '21:00' });
});

test('時刻: 正午 / 深夜0時 / 0時 / 24時', () => {
  expectMatch('正午までに提出', { title: '提出', time: '12:00', matched: { time: '正午' } });
  expectMatch('深夜0時にバックアップ', { title: 'バックアップ', time: '00:00', matched: { time: '深夜0時' } });
  expectMatch('0時にバックアップ', { title: 'バックアップ', time: '00:00', matched: { time: '0時' } });
  expectMatch('24時までに提出', { title: '提出', time: '00:00' });
});

test('時刻: 直後の助詞・語尾を除去', () => {
  expectMatch('10時までに提出', { title: '提出', time: '10:00' });
  expectMatch('10時スタートで会議', { title: '会議', time: '10:00' });
  expectMatch('10時開始の会議', { title: '会議', time: '10:00' });
  expectMatch('10時ぐらいから作業', { title: '作業', time: '10:00' });
});

test('時刻: 期限と時刻の両方を含む', () => {
  expectMatch('明後日の午後3時から打ち合わせ 仕事', {
    title: '打ち合わせ', due: '2026-10-09', time: '15:00', categoryId: 'c-work',
    matched: { due: '明後日', time: '午後3時', category: '仕事' },
  });
  expectMatch('15日の9時に家賃振込', {
    title: '家賃振込', due: '2026-10-15', time: '09:00', matched: { due: '15日', time: '9時' },
  });
  expectMatch('10/20 9時に納品', { title: '納品', due: '2026-10-20', time: '09:00', matched: { due: '10/20', time: '9時' } });
  expectMatch('明日の朝9時に会議', { title: '会議', due: '2026-10-08', time: '09:00', matched: { due: '明日', time: '朝9時' } });
  expectMatch('毎週月曜の10時に定例', { title: '定例', repeat: 'weekly', due: '2026-10-12', time: '10:00' });
  expectMatch('9時に15日の家賃振込', { title: '家賃振込', due: '2026-10-15', time: '09:00' });
  expectMatch('12月24日の夜7時にパーティー', { title: 'パーティー', due: '2026-12-24', time: '19:00' });
});

test('時刻: 優先度の文末「高/中/低」と共存', () => {
  expectMatch('9時に資料作成高', { title: '資料作成', time: '09:00', priority: 'high', matched: { priority: '高' } });
  expectMatch('明日の午後2時までに資料作成 低', { title: '資料作成', due: '2026-10-08', time: '14:00', priority: 'low' });
});

test('時刻: 時刻と判定しないもの', () => {
  expectMatch('3時間かかる作業', { title: '3時間かかる作業', time: null });
  expectMatch('2時間半の作業', { title: '2時間半の作業', time: null });
  expectMatch('時々確認する', { title: '時々確認する', time: null });
  expectMatch('時間を確保する', { title: '時間を確保する', time: null });
  expectMatch('当時の資料を探す', { title: '当時の資料を探す', time: null });
  expectMatch('25時に何か', { title: '25時に何か', time: null });
  expectMatch('9時60分に何か', { title: '9時60分に何か', time: null });
  expectMatch('123時に何か', { title: '123時に何か', time: null });
});

test('時刻: 時刻のみでは due を変更しない', () => {
  const r = parse('15時に電話');
  assert.equal(r.time, '15:00');
  assert.equal(r.due, null);
  assert.equal(r.title, '電話');
});

test('時刻: title が空になったら元テキストをそのまま使う', () => {
  expectMatch('9時', { title: '9時', time: '09:00' });
  expectMatch('正午', { title: '正午', time: '12:00' });
});

test('空白を含む入力でも動作し、余分な空白を整理する', () => {
  expectMatch('明日 までに  請求書 送付  至急', { title: '請求書 送付', due: '2026-10-08', priority: 'high' });
  expectMatch('  本を読む  ', { title: '本を読む' });
});

test('全要素を同時に含む入力', () => {
  expectMatch('毎月二十五日までにLOGIAXISで顧問料請求優先度高', {
    title: '顧問料請求', due: '2026-10-25', priority: 'high', repeat: 'monthly', categoryId: 'c-logi',
    matched: { due: '二十五日', priority: '優先度高', repeat: '毎月', category: 'LOGIAXIS' },
  });
});

test('today を変えた場合の曜日計算', () => {
  expectMatch('金曜に提出', { due: '2026-10-09' }, '2026-10-09');
  expectMatch('金曜に提出', { due: '2026-10-16' }, '2026-10-10');
  expectMatch('来週金曜に提出', { due: '2026-10-16' }, '2026-10-11');
  expectMatch('今週中に提出', { due: '2026-10-11' }, '2026-10-11');
  expectMatch('週末に掃除', { due: '2026-10-11' }, '2026-10-11');
});

test('不正な入力に対して例外を出さない', () => {
  assert.equal(parseTaskText('', { categories, today: TODAY }).title, '');
  assert.equal(parseTaskText(null, { categories, today: TODAY }).due, null);
  assert.equal(parseTaskText('13月40日に何か', { categories, today: TODAY }).title, '13月40日に何か');
  assert.equal(parseTaskText('明日やる', { today: TODAY }).title, 'やる');
});
