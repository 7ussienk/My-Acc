// إعداد الاتصال بقاعدة البيانات (Supabase). تاخذ القيمتين من: Project Settings ← API.
// المفتاح هنا هو المفتاح العام (anon / publishable) وهو مصمم ليكون ظاهرًا؛ الحماية في القاعدة نفسها (RLS).
// لا تحط هنا أبدًا مفتاح service_role ولا كلمة السر.
window.HESABATI = {
  supabaseUrl: 'https://mxodskdvyqtsbuzgokmn.supabase.co',
  supabaseKey: 'sb_publishable_zM5nrDpQu60olP-1vDaHfg_Zm4FE4kf',
  // رابط النسخة القديمة (Apps Script): يُعبّأ تلقائيًا في خانة الترحيل. احذفه بعد ما تخلص الترحيل.
  legacyUrl: 'https://script.google.com/macros/s/AKfycbwOnTlTobsyMsFWDqRKrDahCg9ed5ScM8K5NqJoQ6hK81D2kGAapkz1VcoDkCL5-_UKTg/exec'
};
