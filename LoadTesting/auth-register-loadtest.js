import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  // Simple ramping test for "before HPA"
  stages: [
    { duration: '30s', target: 5 },   // warm-up to 5 VUs
    { duration: '1m',  target: 20 },  // push to 20 VUs
    { duration: '30s', target: 0 },   // ramp down
  ],
};

export default function () {
  const url = 'http://48.201.72.210:3000/auth/register';

  const suffix = `${__VU}${__ITER}${Math.floor(Math.random() * 1e9)}`;

  // Ensure: alphanumeric, 4–30 chars
  const username = (`load${suffix}`).slice(0, 30);

  const payload = JSON.stringify({
    username,
    password: 'LoadTestingPass123!',
  });

  const params = {
    headers: { 'Content-Type': 'application/json' },
  };

  const res = http.post(url, payload, params);

  check(res, {
    'status is 201': (r) => r.status === 201,
  });

  // Small pause to avoid being ultra-aggressive
  sleep(0.2);
}
