// Demo seed (B-08): loads the fake school "Escuela Demo Perico" with teachers,
// courses, students and guardians so the system can be tried and shown without
// real data. Run: npm run seed.
//
// Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SEED_PASSWORD (shared
// password for every demo user — never committed) in .env or the environment.
// Idempotent: deletes the demo school and recreates it; demo users are reused.

import { createClient } from '@supabase/supabase-js';

try {
  process.loadEnvFile();
} catch {
  // .env is optional; variables may come from the host environment
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Falta ${name}: definila en .env o en el entorno.`);
    process.exit(1);
  }
  return value;
}

const supabase = createClient(
  requiredEnv('SUPABASE_URL'),
  requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const SEED_PASSWORD = requiredEnv('SEED_PASSWORD');

const SCHOOL_NAME = 'Escuela Demo Perico';
const DOMAIN = 'demo.rededuca';
const SCHOOL_YEAR = 2026;
const PERIOD = {
  name: '1.er trimestre',
  start_date: '2026-03-02',
  end_date: '2026-06-12',
};

type MembershipRole = 'admin' | 'teacher' | 'guardian' | 'student';

interface DemoUser {
  email: string;
  firstName: string;
  lastName: string;
  role: MembershipRole;
}

const user = (
  email: string,
  firstName: string,
  lastName: string,
  role: MembershipRole,
): DemoUser => ({ email, firstName, lastName, role });

const ADMIN = user(`admin@${DOMAIN}`, 'Admin', 'Demo', 'admin');
const TEACHERS = [
  user(`docente1@${DOMAIN}`, 'Laura', 'Gómez', 'teacher'),
  user(`docente2@${DOMAIN}`, 'Martín', 'Suárez', 'teacher'),
];
const TUTORS = [
  user(`tutor1@${DOMAIN}`, 'María', 'Fernández', 'guardian'),
  user(`tutor2@${DOMAIN}`, 'Jorge', 'Pereyra', 'guardian'),
  user(`tutor3@${DOMAIN}`, 'Ana', 'Domínguez', 'guardian'),
  user(`tutor4@${DOMAIN}`, 'Carlos', 'Benítez', 'guardian'),
  user(`tutor5@${DOMAIN}`, 'Lucía', 'Morales', 'guardian'),
  user(`tutor6@${DOMAIN}`, 'Diego', 'Castillo', 'guardian'),
];

const STUDENT_NAMES: [string, string][] = [
  ['Bautista', 'Acosta'],
  ['Emma', 'Ríos'],
  ['Thiago', 'Medina'],
  ['Mía', 'Herrera'],
  ['Benjamín', 'Paredes'],
  ['Julieta', 'Vega'],
  ['Lorenzo', 'Campos'],
  ['Delfina', 'Soto'],
  ['Mateo', 'Rojas'],
  ['Catalina', 'Núñez'],
  ['Santino', 'Ledesma'],
  ['Olivia', 'Figueroa'],
  ['Bautista', 'Maldonado'],
  ['Isabella', 'Carrizo'],
  ['Felipe', 'Aguirre'],
  ['Martina', 'Ojeda'],
  ['Valentino', 'Bravo'],
  ['Ambar', 'Godoy'],
  ['Joaquín', 'Ponce'],
  ['Alma', 'Salinas'],
];
const STUDENTS = STUDENT_NAMES.map(([firstName, lastName], i) =>
  user(`alumno${i + 1}@${DOMAIN}`, firstName, lastName, 'student'),
);

const ALL_USERS = [ADMIN, ...TEACHERS, ...TUTORS, ...STUDENTS];

async function must(
  what: string,
  query: PromiseLike<{ data: any; error: any }>,
): Promise<any> {
  const { data, error } = await query;
  if (error) {
    throw new Error(`${what}: ${error.message}`);
  }
  return data;
}

// Creates the missing demo auth users and returns email -> user id. Existing
// users are reused; their password is reset to SEED_PASSWORD so reruns always
// leave credentials that work.
async function ensureUsers(): Promise<Map<string, string>> {
  const existing = new Map<string, string>();
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) {
      throw new Error(`listUsers: ${error.message}`);
    }
    for (const u of data.users) {
      if (u.email?.endsWith(`@${DOMAIN}`)) {
        existing.set(u.email, u.id);
      }
    }
    if (data.users.length < 200) {
      break;
    }
  }

  const ids = new Map<string, string>();
  for (const u of ALL_USERS) {
    const known = existing.get(u.email);
    if (known) {
      const { error } = await supabase.auth.admin.updateUserById(known, {
        password: SEED_PASSWORD,
      });
      if (error) {
        throw new Error(`updateUserById ${u.email}: ${error.message}`);
      }
      ids.set(u.email, known);
    } else {
      const { data, error } = await supabase.auth.admin.createUser({
        email: u.email,
        password: SEED_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: `${u.firstName} ${u.lastName}` },
      });
      if (error || !data.user) {
        throw new Error(
          `createUser ${u.email}: ${error?.message ?? 'no user returned'}`,
        );
      }
      ids.set(u.email, data.user.id);
    }
  }
  return ids;
}

async function main() {
  console.log('Creando/actualizando usuarios demo...');
  const ids = await ensureUsers();
  const id = (u: DemoUser): string => ids.get(u.email)!;

  console.log('Limpiando datos demo anteriores...');
  // guardian_links references profiles (not schools), so the school delete does
  // not cascade to it — clean it up explicitly.
  const idList = [...ids.values()];
  await must(
    'delete guardian_links (guardian side)',
    supabase.from('guardian_links').delete().in('guardian_id', idList),
  );
  await must(
    'delete guardian_links (student side)',
    supabase.from('guardian_links').delete().in('student_id', idList),
  );
  await must(
    'delete demo school',
    supabase.from('schools').delete().eq('name', SCHOOL_NAME),
  );

  const school = await must(
    'insert school',
    supabase
      .from('schools')
      .insert({ name: SCHOOL_NAME })
      .select('id')
      .single(),
  );
  if (!school) {
    throw new Error('insert school: no row returned');
  }
  const schoolId: string = school.id;

  // profiles.role is the legacy column (real roles live in memberships) and its
  // check constraint predates 'guardian', so tutors get 'student' there.
  const legacyRole: Record<MembershipRole, string> = {
    admin: 'admin',
    teacher: 'teacher',
    guardian: 'student',
    student: 'student',
  };
  await must(
    'upsert profiles',
    supabase.from('profiles').upsert(
      ALL_USERS.map((u) => ({
        id: id(u),
        school_id: schoolId,
        full_name: `${u.firstName} ${u.lastName}`,
        first_name: u.firstName,
        last_name: u.lastName,
        role: legacyRole[u.role],
      })),
    ),
  );
  await must(
    'insert memberships',
    supabase.from('memberships').insert(
      ALL_USERS.map((u) => ({
        user_id: id(u),
        school_id: schoolId,
        role: u.role,
      })),
    ),
  );

  const courses = await must(
    'insert courses',
    supabase
      .from('courses')
      .insert([
        {
          school_id: schoolId,
          year: 1,
          division: 'A',
          shift: 'morning',
          school_year: SCHOOL_YEAR,
        },
        {
          school_id: schoolId,
          year: 2,
          division: 'A',
          shift: 'morning',
          school_year: SCHOOL_YEAR,
        },
      ])
      .select('id, year'),
  );
  const course1 = courses.find((c: { year: number }) => c.year === 1);
  const course2 = courses.find((c: { year: number }) => c.year === 2);

  const [docente1, docente2] = TEACHERS.map(id);
  await must(
    'insert subjects',
    supabase.from('subjects').insert([
      { course_id: course1.id, teacher_id: docente1, name: 'Matemática' },
      { course_id: course1.id, teacher_id: docente2, name: 'Lengua' },
      { course_id: course2.id, teacher_id: docente1, name: 'Matemática' },
      {
        course_id: course2.id,
        teacher_id: docente2,
        name: 'Ciencias Naturales',
      },
    ]),
  );

  const studentIds = STUDENTS.map(id);
  await must(
    'insert enrollments',
    supabase
      .from('enrollments')
      .insert([
        ...studentIds
          .slice(0, 10)
          .map((student_id) => ({ student_id, course_id: course1.id })),
        ...studentIds
          .slice(10)
          .map((student_id) => ({ student_id, course_id: course2.id })),
      ]),
  );

  // tutor1 has 3 kids; the remaining students are split across tutor2..6 so
  // every demo guardian sees students in GET /me/students.
  const tutorIds = TUTORS.map(id);
  const links = studentIds
    .slice(0, 3)
    .map((student_id) => ({ guardian_id: tutorIds[0], student_id }));
  studentIds.slice(3).forEach((student_id, i) => {
    links.push({
      guardian_id: tutorIds[1 + (i % (tutorIds.length - 1))],
      student_id,
    });
  });
  await must(
    'insert guardian_links',
    supabase.from('guardian_links').insert(links),
  );

  await must(
    'insert period',
    supabase.from('periods').insert({ school_id: schoolId, ...PERIOD }),
  );

  console.log(`Listo: ${SCHOOL_NAME}`);
  console.log(`  ${ALL_USERS.length} usuarios (${STUDENTS.length} alumnos)`);
  console.log(
    '  2 cursos, 4 materias, 20 inscripciones, 20 vínculos tutor-hijo',
  );
  console.log(`  Período: ${PERIOD.name}`);
  console.log('  Todos los usuarios usan la contraseña de SEED_PASSWORD.');
  console.log(`  Probá GET /me con ${TUTORS[0].email} (3 hijos, 1.º A).`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
