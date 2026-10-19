import { Link, useNavigate } from 'react-router';
import { useArchive } from '../lib/archive';
import { supabase } from '../lib/supabase';

/** The links every signed-in page shares. */
export function Header() {
  const archive = useArchive();
  const navigate = useNavigate();

  async function signOut() {
    // to the front page FIRST: a page that loses its session on its own address says
    // "you were signed out" and offers to come back, which is not what a sign-out means
    void navigate('/', { replace: true });
    await supabase.auth.signOut();
  }

  return (
    <header>
      <nav>
        <Link to="/">별의 기록</Link>
        {archive.writer && (
          <>
            {' · '}
            <Link to="/new" data-testid="nav-new">
              기억 남기기
            </Link>
          </>
        )}
        {' · '}
        <button type="button" data-testid="sign-out" onClick={() => void signOut()}>
          로그아웃
        </button>
      </nav>
    </header>
  );
}
