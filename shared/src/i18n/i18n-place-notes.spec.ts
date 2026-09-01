import ar from './ar';
import br from './br';
import ca from './ca';
import cs from './cs';
import de from './de';
import en from './en';
import es from './es';
import fr from './fr';
import gr from './gr';
import hu from './hu';
import id from './id';
import itLocale from './it';
import ja from './ja';
import ko from './ko';
import nl from './nl';
import pl from './pl';
import ru from './ru';
import sv from './sv';
import tr from './tr';
import uk from './uk';
import vi from './vi';
import zh from './zh';
import zhTW from './zh-TW';

import { describe, expect, it } from 'vitest';

const locales = {
  ar,
  br,
  ca,
  cs,
  de,
  en,
  es,
  fr,
  gr,
  hu,
  id,
  it: itLocale,
  ja,
  ko,
  nl,
  pl,
  ru,
  sv,
  tr,
  uk,
  vi,
  'zh-TW': zhTW,
  zh,
} as const;

const legacyPersonalPlaceNotes = [
  'Personal notes...',
  'ملاحظات شخصية...',
  'Notas pessoais...',
  'Notes personals...',
  'Osobní poznámky...',
  'Persönliche Notizen...',
  'Notas personales...',
  'Notes personnelles…',
  'Προσωπικές σημειώσεις...',
  'Személyes jegyzetek...',
  'Catatan pribadi...',
  'Note personali...',
  '個人的なメモ…',
  '개인 메모...',
  'Persoonlijke notities...',
  'Osobiste notatki...',
  'Личные заметки...',
  'Personliga anteckningar...',
  'Kişisel notlar...',
  'Особисті нотатки...',
  'Ghi chú cá nhân...',
  '個人備註...',
  '个人备注...',
];

const enLinkHint =
  'Anyone with the link can view this trip without logging in. Read-only — no editing possible. If Map & Plan is shared, place and itinerary notes are visible to anyone with the link.';
const koLinkHint =
  '로그인 없이 누구나 이 링크로 여행을 볼 수 있습니다. 읽기 전용이며 편집할 수 없습니다. 지도 및 계획을 공유하면 장소 메모와 일정 메모가 링크를 가진 사람에게 표시됩니다.';

const disclosureMarkers: Record<
  keyof typeof locales,
  { access: RegExp; readOnly: RegExp; map: RegExp; place: RegExp; itinerary: RegExp; placeholder: RegExp }
> = {
  ar: {
    access: /تسجيل الدخول/,
    readOnly: /للقراءة فقط/,
    map: /الخريطة والخطة/,
    place: /ملاحظات الأماكن/,
    itinerary: /خطة الرحلة/,
    placeholder: /ملاحظات المكان/,
  },
  br: {
    access: /login/,
    readOnly: /somente leitura/,
    map: /Mapa e plano/,
    place: /notas dos locais/,
    itinerary: /roteiro/,
    placeholder: /Notas do local/,
  },
  ca: {
    access: /iniciar sessió/,
    readOnly: /Només lectura/,
    map: /mapa i el pla/,
    place: /notes dels llocs/,
    itinerary: /itinerari/,
    placeholder: /Notes del lloc/,
  },
  cs: {
    access: /přihlášení/,
    readOnly: /pouze pro čtení/,
    map: /mapu a plán/,
    place: /poznámky k místům/,
    itinerary: /itineráři/,
    placeholder: /Poznámky k místu/,
  },
  de: {
    access: /Anmeldung/,
    readOnly: /schreibgeschützt/,
    map: /Karte & Plan/,
    place: /Notizen zu Orten/,
    itinerary: /Reiseplan/,
    placeholder: /Notizen zum Ort/,
  },
  en: {
    access: /logging in/,
    readOnly: /Read-only/,
    map: /Map & Plan/,
    place: /place/,
    itinerary: /itinerary notes/,
    placeholder: /Place notes/,
  },
  es: {
    access: /iniciar sesión/,
    readOnly: /solo lectura/,
    map: /mapa y el plan/,
    place: /notas de los lugares/,
    itinerary: /itinerario/,
    placeholder: /Notas del lugar/,
  },
  fr: {
    access: /se connecter/,
    readOnly: /lecture seule/,
    map: /carte et le plan/,
    place: /notes sur les lieux/,
    itinerary: /itinéraire/,
    placeholder: /Notes sur le lieu/,
  },
  gr: {
    access: /συνδεθεί/,
    readOnly: /μόνο για ανάγνωση/,
    map: /Χάρτη και το Πλάνο/,
    place: /σημειώσεις για τα μέρη/,
    itinerary: /πρόγραμμα/,
    placeholder: /Σημειώσεις για το μέρος/,
  },
  hu: {
    access: /bejelentkezés/,
    readOnly: /Csak olvasható/,
    map: /térkép és a terv/,
    place: /helyekhez/,
    itinerary: /útiterv/,
    placeholder: /Helyhez tartozó jegyzetek/,
  },
  id: {
    access: /login/,
    readOnly: /Hanya baca/,
    map: /Peta & Rencana/,
    place: /catatan tempat/,
    itinerary: /rencana perjalanan/,
    placeholder: /Catatan tempat/,
  },
  it: {
    access: /accesso/,
    readOnly: /Solo lettura/,
    map: /Mappa e programma/,
    place: /note sui luoghi/,
    itinerary: /itinerario/,
    placeholder: /Note sul luogo/,
  },
  ja: {
    access: /ログインせず/,
    readOnly: /閲覧専用/,
    map: /地図・プラン/,
    place: /場所のメモ/,
    itinerary: /行程のメモ/,
    placeholder: /場所のメモ/,
  },
  ko: {
    access: /로그인 없이/,
    readOnly: /읽기 전용/,
    map: /지도 및 계획/,
    place: /장소 메모/,
    itinerary: /일정 메모/,
    placeholder: /장소 메모/,
  },
  nl: {
    access: /in te loggen/,
    readOnly: /Alleen-lezen/,
    map: /Kaart en plan/,
    place: /notities over plaatsen/,
    itinerary: /reisplan/,
    placeholder: /Notities over de plek/,
  },
  pl: {
    access: /logowania/,
    readOnly: /Tylko do odczytu/,
    map: /mapę i plan/,
    place: /notatki dotyczące miejsc/,
    itinerary: /planu podróży/,
    placeholder: /Notatki dotyczące miejsca/,
  },
  ru: {
    access: /входа в систему/,
    readOnly: /Только чтение/,
    map: /картой и планом/,
    place: /заметки о местах/,
    itinerary: /плане поездки/,
    placeholder: /Заметки о месте/,
  },
  sv: {
    access: /logga in/,
    readOnly: /Endast läsbehörighet/,
    map: /Karta & Plan/,
    place: /anteckningar om platser/,
    itinerary: /resplanen/,
    placeholder: /Anteckningar om platsen/,
  },
  tr: {
    access: /giriş yapmadan/,
    readOnly: /Salt okunur/,
    map: /Harita ve Plan/,
    place: /yer notları/,
    itinerary: /seyahat planı notları/,
    placeholder: /Yer notları/,
  },
  uk: {
    access: /входу в систему/,
    readOnly: /Лише читання/,
    map: /картою і планом/,
    place: /нотатки про місця/,
    itinerary: /план подорожі/,
    placeholder: /Нотатки про місце/,
  },
  vi: {
    access: /đăng nhập/,
    readOnly: /Chỉ đọc/,
    map: /Bản đồ & Kế hoạch/,
    place: /ghi chú về địa điểm/,
    itinerary: /lịch trình/,
    placeholder: /Ghi chú về địa điểm/,
  },
  'zh-TW': {
    access: /免登入/,
    readOnly: /僅供檢視/,
    map: /地圖與計劃/,
    place: /地點備註/,
    itinerary: /行程備註/,
    placeholder: /地點備註/,
  },
  zh: {
    access: /无需登录/,
    readOnly: /仅供查看/,
    map: /地图与计划/,
    place: /地点备注/,
    itinerary: /行程备注/,
    placeholder: /地点备注/,
  },
};

const caseInsensitive = (marker: RegExp): RegExp => new RegExp(marker.source, `${marker.flags}iu`);

function translationString(strings: typeof en, key: string): string {
  const value = strings[key];
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be a string`);
  return value;
}

describe('shared place-note wording', () => {
  it('keeps the canonical English and Korean disclosure copy exact', () => {
    expect(en['places.formNotesPlaceholder']).toBe('Place notes...');
    expect(en['share.linkHint']).toBe(enLinkHint);
    expect(ko['places.formNotesPlaceholder']).toBe('장소 메모...');
    expect(ko['share.linkHint']).toBe(koLinkHint);
  });

  it('provides place-note and public-disclosure keys in all supported locales', () => {
    for (const [locale, strings] of Object.entries(locales)) {
      expect(strings['places.formNotesPlaceholder'], locale).toEqual(expect.any(String));
      expect(strings['share.linkHint'], locale).toEqual(expect.any(String));
    }
  });

  it('does not describe the shared place field as personal or private', () => {
    for (const [locale, strings] of Object.entries(locales)) {
      const placeholder = translationString(strings, 'places.formNotesPlaceholder');
      const markers = disclosureMarkers[locale as keyof typeof disclosureMarkers];
      expect(legacyPersonalPlaceNotes, `${locale} still uses legacy personal-note wording`).not.toContain(placeholder);
      expect(placeholder.toLocaleLowerCase()).not.toMatch(/personal|private/);
      expect(placeholder, `${locale} must identify notes attached to a place`).toMatch(
        caseInsensitive(markers.placeholder),
      );
    }
  });

  it('discloses read-only access and Map & Plan note visibility in every locale', () => {
    for (const [locale, strings] of Object.entries(locales)) {
      const hint = translationString(strings, 'share.linkHint');
      const markers = disclosureMarkers[locale as keyof typeof disclosureMarkers];
      expect(hint, `${locale} must mention login-free viewing`).toMatch(caseInsensitive(markers.access));
      expect(hint, `${locale} must mention read-only access`).toMatch(caseInsensitive(markers.readOnly));
      expect(hint, `${locale} must identify Map & Plan`).toMatch(caseInsensitive(markers.map));
      expect(hint, `${locale} must disclose place notes`).toMatch(caseInsensitive(markers.place));
      expect(hint, `${locale} must disclose itinerary notes`).toMatch(caseInsensitive(markers.itinerary));
    }
  });
});
