# claude-mods

Claude Code 터미널의 입력창 위에 한 줄짜리 정보를 더해 주는 모드 두 개입니다.

| 모드 | 하는 일 | 지원 환경 |
| --- | --- | --- |
| **total-stats** | 모델·effort·fast 모드, 남은 컨텍스트 게이지, 5시간 한도, 직전 대화의 토큰과 걸린 시간, 세션 전체 턴·토큰·스킬 횟수를 색으로 구분해 한 줄로 보여줍니다 | 모든 OS |
| **image-peek** | 입력창에 붙여 넣은 이미지(`[Image #1]`)를 보내기 전에 목록으로 보여주고, 누르면 원본을 사진 뷰어로 엽니다 | Windows |

```
📎 [ Image 1 ] [ Image 2 ]
🧠 Opus 5.5 · medium · ⚡fast · ctx ███████░░░ 68% · 5h 23% · 직전 4.0k ⏱1m23s · 세션 12턴 244.0k $0.31 · 스킬 3
> 이거 봐줘 [Image #1] [Image #2]
```

## 설치

Claude Code 터미널의 입력창에 입력합니다. 필요한 것만 설치해도 됩니다.

```
/plugin install total-stats --marketplace glglekdy/claude-mods
/plugin install image-peek --marketplace glglekdy/claude-mods
```

처음 설치할 때 마켓플레이스를 추가할지 물으면 `y`, 설치 범위는 `user`(모든 세션)를 고르면 됩니다. 설치한 세션에서 바로 켜집니다.

끄기와 지우기:

```
claude plugin disable total-stats
claude plugin uninstall total-stats
```

## total-stats

| 항목 | 내용 | 색 |
| --- | --- | --- |
| 🧠 모델 | 지금 대화에 쓰이는 모델 | Claude 색, 굵게 |
| effort | 실제 요청에 적용된 effort | 강조색 |
| fast | 설정의 `fastMode` | 켜짐은 노랑, 꺼짐은 흐리게 |
| ctx | 남은 컨텍스트, 10칸 게이지 | 50% 넘게 남으면 초록, 20~50% 노랑, 20% 밑 빨강 |
| 5h | 5시간 사용 한도를 쓴 비율(구독 요금제일 때만) | 같은 기준 |
| 직전 | 바로 전 대화 한 번(턴)에 쓴 토큰과 ⏱걸린 시간 | 시간은 강조색 |
| 세션 | 이번 세션의 턴 수, 전체 토큰(서브에이전트 포함)과 비용 | 비용은 초록 |
| 스킬 | 이번 세션에서 스킬을 부른 횟수(`/이름`, Skill 도구, 서브에이전트 미리 불러오기 포함) | |

- `/model`, `/effort`, `/fast`로 바꾸면 늦어도 2초 안에 반영됩니다.
- 토큰·턴·스킬 횟수는 모드가 켜진 뒤부터 셉니다. 세션마다 따로 저장해서 여러 창을 열어도 섞이지 않습니다.
- 창이 좁으면 줄을 바꾸지 않고 오른쪽 끝을 자릅니다.
- `/fast`를 세션마다 따로 켜는 설정에서는 fast 표시가 실제 상태와 다를 수 있습니다.

## image-peek

- 이미지를 붙여 넣어 입력창에 `[Image #1]`이 생기면 바로 위에 `[ Image 1 ]` 버튼이 생깁니다.
- 버튼을 누르면 원본 파일이 Windows 기본 사진 뷰어로 열립니다.
- 입력창에서 `[Image #1]`을 지우면 목록에서도 빠지고, 메시지를 보내면 목록이 비워집니다.

원본 파일은 이렇게 찾습니다.

1. 붙여 넣은 글에 이미지 파일 경로가 있으면 그 경로를 씁니다. 예를 들어 Orca 터미널은 `%TEMP%\orca-paste-….png`로 저장합니다.
2. 경로 없이 `[Image #N]`만 들어오면 `%TEMP%`에서 15초 안에 새로 생긴 이미지 파일을 씁니다.
3. 둘 다 없으면 버튼은 나오지만, 누르면 "원본 파일을 찾지 못했어요"라고 알려줍니다.

> Windows의 Orca 터미널에서 확인했습니다. 다른 터미널은 이미지를 붙여 넣는 방식이 달라 원본을 못 찾을 수 있고, macOS와 Linux에서는 이미지가 열리지 않습니다.

## 직접 고쳐 쓰기

```
git clone https://github.com/glglekdy/claude-mods
claude --plugin-dir ./claude-mods/total-stats
```

```
claude plugin validate ./claude-mods/total-stats
claude plugin test ./claude-mods/total-stats
```
