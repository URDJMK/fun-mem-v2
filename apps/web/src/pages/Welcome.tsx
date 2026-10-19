import { useState } from 'react';
import { useLocation } from 'react-router';
import { returnPath, supabase } from '../lib/supabase';

/**
 * The first page, for someone who is not signed in: v1's words, in v1's order, and one
 * button. No design on purpose; the new design comes later. (v1's star chart and its
 * caption are pictures, not text, so they are not here.)
 */
export function Welcome() {
  const ended = (useLocation().state as { ended?: boolean } | null)?.ended === true;
  const [failed, setFailed] = useState(false);

  async function signIn() {
    setFailed(false);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        // back to the page whose session ended, when there was one
        options: { redirectTo: `${window.location.origin}${returnPath()}` },
      });
      if (error) setFailed(true);
    } catch {
      setFailed(true);
    }
  }

  return (
    <main>
      <title>별의 기록 — 가족이 적어 둔 문장으로만 답합니다</title>

      <p>별의 기록</p>

      <section>
        <p>The Engraved Sky</p>
        <h1>
          「그때 어머니가
          <br />
          뭐라고 하셨더라…」
        </h1>
        <p>
          이 물음에 답할 수 있는 것은 가족이 적어 둔 문장뿐입니다. 별의 기록은 적힌 문장만 옮기고,
          적히지 않은 것은 답하지 않습니다.
        </p>

        {ended && (
          <p role="status" data-testid="welcome-ended">
            로그아웃되었습니다. 다시 로그인하면 이 화면으로 돌아옵니다.
          </p>
        )}
        <p>
          <button type="button" data-testid="login-google" onClick={() => void signIn()}>
            Google로 들어가기
          </button>
        </p>
        {failed && (
          <p role="alert" data-testid="login-error">
            로그인하지 못했습니다. 잠시 뒤에 다시 시도해 주세요.
          </p>
        )}
      </section>

      <section id="record">
        <p>Record</p>
        <h2>적힌 것</h2>
        <p>아래 기록은 실제 가족의 것이 아니라, 이 페이지를 위해 지어낸 예시입니다.</p>
        <p>「그때 어머니가 뭐라고 하셨더라…」</p>
        <blockquote>
          1997년 겨울, 회사를 그만두고 집에 내려간 날이었다. 어머니는 아무것도 묻지 않으셨다. 밥상을
          차려 주시고, 다 먹고 일어설 때에야 밥은 먹고 다녀라, 하셨다.
        </blockquote>
        <p>둘째 딸 · 2026. 3.</p>
      </section>

      <section id="abstention">
        <p>Abstention</p>
        <h2>답하지 않는 것</h2>
        <p>
          저는 이 기록을 바탕으로 답하는 AI입니다. 제 답변은 기록이 아니며 증거로 저장되지 않습니다.
        </p>
        <Exchange
          q="어머니가 배웅하실 때 늘 하시던 말이 있나요?"
          a="밥은 먹고 다녀라, 하셨다."
          note="기록 2곳에서 나온 문장입니다."
          sources={['둘째 딸 2026. 3.', '막내아들 2026. 4.']}
        />
        <Exchange
          q="어머니는 그때 서운하셨을까요?"
          a="기록에 이 질문에 답할 만한 내용이 충분하지 않습니다. 가족에게 여쭤보시겠어요?"
          note="기록 2개를 읽었습니다. 답이 될 문장은 없습니다."
        />
        <p>지어내는 대신 멈춥니다.</p>
      </section>

      <section id="authorship">
        <p>Authorship</p>
        <h2>이 문장을 쓴 사람</h2>
        <p>
          여기 있는 문장은 모두 가족이, 또는 본인이 살아 계실 때 직접 쓴 것입니다. 돌아가신 분이
          남긴 자료를 긁어모아 만든 것이 아닙니다.
        </p>
        <p>
          지금 이 서비스는 돌아가신 분의 목소리나 얼굴을 만들지 않습니다. 언젠가 만들게 되더라도, 그
          결정은 본인이 살아 계실 때 남긴 허락에 따릅니다. 허락이 없으면 만들지 않습니다.
        </p>
      </section>

      <section id="keeping">
        <p>Keeping</p>
        <h2>누가 보고, 무엇이 남는가</h2>
        <dl>
          <dt>Grounding</dt>
          <dd>가족이 적어 둔 문장만 옮깁니다. 없으면 없다고 말합니다.</dd>
          <dt>Who sees</dt>
          <dd>
            기록은 이 보관소에 속한 사람에게만 열립니다. 링크를 아는 것만으로는 열리지 않습니다.
          </dd>
          <dt>Not for sale</dt>
          <dd>네이버에도 구글에도 나오지 않고, 광고에도 AI 학습에도 쓰지 않습니다.</dd>
          <dt>Consent</dt>
          <dd>기록마다 누가 볼 수 있는지 정해 두고, 고친 내용은 덮어쓰지 않고 따로 남습니다.</dd>
          <dt>Export</dt>
          <dd>
            기록은 메모장에서도 그대로 열리는 글 파일입니다. 읽을 수 있는 기록은 언제든 내려받을 수
            있습니다.
          </dd>
        </dl>
        <p>저희가 문을 닫아도, 내려받으신 파일은 그대로 열립니다.</p>
        <p>그때는 저희가 필요 없습니다.</p>
      </section>

      <section id="door">
        <p>Door</p>
        <h2>문 앞에서</h2>
        <p>남은 물건을 정리하다가 나온 사진 한 장에서 시작해도 괜찮습니다.</p>
        <p>처음에 여쭙는 것은 두 가지뿐입니다. 누구의 기록인지, 그리고 어느 나라 법을 따를지.</p>
      </section>

      <footer>
        <p>별의 기록</p>
        <p>이용약관 · 개인정보</p>
      </footer>
    </main>
  );
}

/** One question and its answer, as v1's page shows them. */
function Exchange({
  q,
  a,
  note,
  sources,
}: {
  q: string;
  a: string;
  note: string;
  sources?: string[];
}) {
  return (
    <dl>
      <dt>묻기</dt>
      <dd>{q}</dd>
      <dt>답</dt>
      <dd>
        <p>{a}</p>
        <p>{note}</p>
        {sources && (
          <ul>
            {sources.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        )}
      </dd>
    </dl>
  );
}
