"""发起端点的表单字段透传。

这条链的三个开关（build_vector / extract_concepts / trial_run）都花钱，
HTTP 层漏掉任何一个，页面上的开关就是个装饰——2026-08-16 之前 trial_run
正是这样漏的：`create_run` 早就收这个参数，表单不收，页面发起的 run 永远跳过 ⑥⑦。
所以这里只盯一件事：表单里写了什么，`create_run` 就得收到什么。链本身不跑。
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api import intake_routes


@pytest.fixture()
def client(monkeypatch):
    """把 create_run/start_run 换成录音机——本用例不跑链，只看参数。"""
    seen: dict = {}

    class _Run:
        run_id = "20260816T000000-test"
        corpus = "probe"
        # options 与 flush 是真 IntakeRun 有的：路由拿到 run 之后还会往 options 里补一条
        # tier_definitions 再 flush 一次（档位定义原文只落记录，不进 create_run 的签名）。
        record = {"status": "running", "files": [1], "options": {}}

        def flush(self):
            seen["flushed"] = seen.get("flushed", 0) + 1
            seen["options"] = dict(self.record["options"])
            seen["inbox_record"] = dict(self.record.get("inbox") or {})

    # 站点化之后路由只调 create_run_deferred（收 kind/ref，不碰投料内容），
    # create_run 不再出现在请求路径上——录音机跟着换探头。
    def _deferred(kind, ref, **kwargs):
        seen.update(kwargs)
        seen["kind"] = kind
        seen["ref"] = ref
        run = _Run()
        run.record["inbox"] = {"kind": kind, "ref": ref}
        # deferred 合同：文件清单接收站①收完才填，此刻必须是空数组
        run.record["files"] = []
        return run

    monkeypatch.setattr(intake_routes.domain_intake, "create_run_deferred", _deferred)
    monkeypatch.setattr(intake_routes.domain_intake, "start_run", lambda run: None)
    monkeypatch.setenv("AI_SERVICE_TOKEN", "probe-token")

    app = FastAPI()
    app.include_router(intake_routes.router)
    with TestClient(app) as c:
        yield c, seen


def _post(client, data):
    return client.post(
        "/api/domain-intake/runs",
        headers={"x-internal-token": "probe-token"},
        files=[("files", ("a.md", "# t\n\n正文".encode("utf-8"), "text/markdown"))],
        data=data,
    )


def test_switches_default_off(client):
    c, seen = client
    assert _post(c, {"corpus": "probe"}).status_code == 200
    assert seen["build_vector"] is False
    assert seen["extract_concepts"] is False
    assert seen["trial_run"] is False


def test_switches_pass_through(client):
    c, seen = client
    resp = _post(
        c,
        {
            "corpus": "probe",
            "scope": "时序数据库运维",
            "tier_range": "L1-L2",
            "build_vector": "true",
            "extract_concepts": "true",
            "trial_run": "true",
        },
    )
    assert resp.status_code == 200
    assert seen["build_vector"] is True
    assert seen["extract_concepts"] is True
    assert seen["trial_run"] is True
    assert seen["scope"] == "时序数据库运维" and seen["tier_range"] == "L1-L2"


def test_token_required(client):
    c, _ = client
    resp = c.post(
        "/api/domain-intake/runs",
        files=[("files", ("a.md", b"# t", "text/markdown"))],
        data={"corpus": "probe"},
    )
    assert resp.status_code == 401


def test_tier_definitions_land_in_run_options(client):
    """管理端表单里管理者用自己的话写的档位定义，要原样落进 run 记录。

    这是备注字段：跑链的任何一站都不读它，唯一的用途是 run 页面回看时能看到
    「当初是按什么标准分的档」。掉了不会有任何一站报错，所以得有条测试盯着。
    """
    c, seen = client
    defs = '[{"label":"入门","audience":"零基础新人"},{"label":"进阶","audience":"能独立排障的人"}]'
    resp = _post(c, {"corpus": "probe", "tier_range": "L1-L2", "tier_definitions": defs})
    assert resp.status_code == 200
    # 档位定义不是 create_run 的入参（那条签名没动），是路由拿到 run 之后补进 options 的
    assert "tier_definitions" not in seen
    assert seen["tier_range"] == "L1-L2"
    assert seen["flushed"] == 1
    assert seen["options"]["tier_definitions"] == [
        {"label": "入门", "audience": "零基础新人"},
        {"label": "进阶", "audience": "能独立排障的人"},
    ]


def test_tier_definitions_bad_json_does_not_block_the_run(client):
    """写坏了照样发车：这是备注字段，为它 400 掉一次接入不划算，原始串存下来供人看。"""
    c, seen = client
    assert _post(c, {"corpus": "probe", "tier_definitions": "{不是 json"}).status_code == 200
    assert seen["options"]["tier_definitions"] == "{不是 json"


def test_tier_definitions_absent_leaves_options_alone(client):
    """不填就不写这个键——老 run 没有它，页面按「有没有」分支，别塞个空串进去。"""
    c, seen = client
    assert _post(c, {"corpus": "probe"}).status_code == 200
    assert "flushed" not in seen


# ── 三条投料形态：files / zip / gitUrl ───────────────────────────────────────
#
# 安全线（zip slip、解压总量、非 https、clone 超时）在 tests/test_intake_sources.py
# 逐条盯。这里只盯 HTTP 面：三选一有没有拦住，zip 解出来的树有没有原样交给链，
# 以及投料层的失败是不是 400 而不是 500。


@pytest.fixture()
def dir_client(client, monkeypatch):
    """在录音机上再加一路：收目录树的 `create_run_from_dir`。"""
    from pathlib import Path

    c, seen = client

    class _Run:
        run_id = "20260816T000000-dir"
        corpus = "probe"
        record = {"status": "running", "files": [1, 2], "options": {}}

        def flush(self):
            seen["options"] = dict(self.record["options"])

    def _from_dir(src_dir, **kwargs):
        seen.update(kwargs)
        seen["tree"] = sorted(
            p.relative_to(src_dir).as_posix() for p in Path(src_dir).rglob("*") if p.is_file()
        )
        seen["staged"] = str(src_dir)
        return _Run()

    monkeypatch.setattr(intake_routes.domain_intake, "create_run_from_dir", _from_dir)
    return c, seen


def _zip_bytes(entries: dict[str, bytes]) -> bytes:
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, blob in entries.items():
            zf.writestr(name, blob)
    return buf.getvalue()


def test_no_source_given_is_rejected(client):
    c, _ = client
    resp = c.post(
        "/api/domain-intake/runs",
        headers={"x-internal-token": "probe-token"},
        data={"corpus": "probe"},
    )
    assert resp.status_code == 400
    assert "三选一" in resp.json()["detail"] and "一条都没给" in resp.json()["detail"]


def test_two_sources_at_once_is_rejected(client):
    c, _ = client
    resp = c.post(
        "/api/domain-intake/runs",
        headers={"x-internal-token": "probe-token"},
        files=[("files", ("a.md", b"# t", "text/markdown"))],
        data={"corpus": "probe", "gitUrl": "https://github.com/apache/iotdb.git"},
    )
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert "files" in detail and "gitUrl" in detail


def test_zip_is_spooled_to_disk_and_deferred(dir_client):
    """整本书走 zip：请求路径**只落盘不解压**（第五坎教训——解压在请求路径里
    把 2vCPU/4G 整机打满）。断言三件事：包一个字节不差地落在盘上、原始包名
    进了 run 记录（回看查得到来源）、响应立刻带 run_id 且标 deferred。
    解压/收集的正确性在 tests/test_intake_sources.py 与
    test_domain_intake.py 的 _materialize_inbox 用例盯。"""
    c, seen = dir_client
    blob = _zip_bytes(
        {
            "book/ch1/intro.md": "# 一\n".encode() + "正文内容".encode() * 100,
            "book/ch2/detail.md": "# 二\n".encode() + "正文内容".encode() * 100,
            "book/img/cover.png": b"\x89PNG" + b"\x00" * 100,
        }
    )
    resp = c.post(
        "/api/domain-intake/runs",
        headers={"x-internal-token": "probe-token"},
        files=[("zip", ("book.zip", blob, "application/zip"))],
        data={"corpus": "probe", "scope": "时序数据库运维"},
    )
    assert resp.status_code == 200, resp.text
    assert seen["kind"] == "zip"
    assert seen["corpus"] == "probe" and seen["scope"] == "时序数据库运维"
    from pathlib import Path

    spooled = Path(seen["ref"])
    assert spooled.exists() and spooled.read_bytes() == blob
    body = resp.json()
    assert body["source"] == {"kind": "zip", "deferred": True}
    # 文件数此刻必须是 0——接收站①收完才知道，谎报终值不如不报
    assert body["files"] == 0
    assert body["run_id"] and body["events_url"].endswith("/events")
    # 原始包名（不是落盘名 upload-<stamp>.zip）要进 run 记录
    assert seen["inbox_record"]["filename"] == "book.zip"
    spooled.unlink()


def test_bad_zip_still_creates_a_run_and_fails_at_station_one(dir_client):
    c, c2 = dir_client
    resp = c.post(
        "/api/domain-intake/runs",
        headers={"x-internal-token": "probe-token"},
        files=[("zip", ("book.zip", b"not a zip at all", "application/zip"))],
        data={"corpus": "probe"},
    )
    # 站点化改判：请求路径不开包，坏包也 200 建 run——它会在接收站①失败，
    # 失败可见且带理由（站点级行为在 test_domain_intake 的 _materialize_inbox
    # 用例盯）。这里只保证：不 500、run 建了、包原样落盘等①去发现问题。
    assert resp.status_code == 200, resp.text
    from pathlib import Path

    seen = c2  # dir_client 的录音
    assert seen["kind"] == "zip" and Path(seen["ref"]).exists()
    Path(seen["ref"]).unlink()


def test_non_https_git_url_is_rejected(dir_client):
    c, _ = dir_client
    resp = c.post(
        "/api/domain-intake/runs",
        headers={"x-internal-token": "probe-token"},
        data={"corpus": "probe", "gitUrl": "git@github.com:apache/iotdb.git"},
    )
    assert resp.status_code == 400 and "https" in resp.json()["detail"]


def test_clone_never_runs_in_the_request_path(dir_client, monkeypatch):
    """站点化改判：大陆机房 clone GitHub 卡死那件事，解法从「请求里超时 400」
    变成「clone 根本不进请求路径」——地址合法性同步查（纯字符串、零成本），
    真正的拉取在接收站①后台跑，超时以站失败呈现。这条钉住请求路径不碰网络。"""
    c, seen = dir_client

    def _must_not_clone(url, dest, **kw):
        raise AssertionError("clone_repo 不允许出现在请求路径里")

    monkeypatch.setattr(intake_routes.intake_sources, "clone_repo", _must_not_clone)
    resp = c.post(
        "/api/domain-intake/runs",
        headers={"x-internal-token": "probe-token"},
        data={"corpus": "probe", "gitUrl": "https://github.com/apache/iotdb.git"},
    )
    assert resp.status_code == 200, resp.text
    assert seen["kind"] == "git"
    assert seen["ref"] == "https://github.com/apache/iotdb.git"
    body = resp.json()
    assert body["source"] == {"kind": "gitUrl", "deferred": True}
    assert body["run_id"] and body["files"] == 0


def test_single_zip_in_the_files_field_is_rerouted_to_the_zip_path(dir_client):
    """整包传错格子不该让人白等十分钟。

    2026-08-24 实测：149MB 的 sm-merge.zip 从「多文件」那一格传上来，走了 dir 分支，
    `collect_readable` 在目录里找不到 md/txt/rst/pdf，报「这份投料里没有任何可读文档」——
    包完好、里面 389 个 md 也在，只是没人解它。**传完才失败**，那次白等了十分钟。
    """
    c, seen = dir_client
    blob = _zip_bytes({"book/ch1/intro.md": "# 一\n".encode() + "正文内容".encode() * 100})
    resp = c.post(
        "/api/domain-intake/runs",
        headers={"x-internal-token": "probe-token"},
        files=[("files", ("sm-merge.zip", blob, "application/zip"))],
        data={"corpus": "probe"},
    )
    assert resp.status_code == 200, resp.text
    # 关键：从 files 那一格进来，仍然走 zip 那条路，包会被解开
    assert seen["kind"] == "zip", "单个 zip 传进多文件格子时没有改道，又会在①站白失败一次"
    from pathlib import Path

    spooled = Path(seen["ref"])
    assert spooled.exists() and spooled.read_bytes() == blob
    assert seen["inbox_record"]["filename"] == "sm-merge.zip"
    spooled.unlink()


def test_unreadable_suffix_in_the_files_field_is_rejected_at_request_time(dir_client):
    """收不了的格式当场退，别落盘之后到①站才说。

    直传那条路（`create_run`）本来就按 ALLOWED_SUFFIXES 挡着，延迟收料这条路绕过了。
    两条路的判据不该有分叉。
    """
    c, _seen = dir_client
    resp = c.post(
        "/api/domain-intake/runs",
        headers={"x-internal-token": "probe-token"},
        files=[
            ("files", ("guide.md", "# 一\n正文".encode() * 50, "text/markdown")),
            ("files", ("payload.exe", b"MZ" + b"\x00" * 200, "application/octet-stream")),
        ],
        data={"corpus": "probe"},
    )
    assert resp.status_code == 400, resp.text
    detail = resp.json()["detail"]
    assert ".exe" in detail and "压缩包" in detail, detail


# ── 岗位/技能清单（WO-5：把「管理员可以补传」从空承诺变成真投料口）──────────
#
# 与档位定义相反，这一格要严：它会原样成为学习端岗位技能页的唯一数据源，
# 静默丢一条坏岗位，学员看到的是一份没人写过的岗位表，而且没有任何一处会报错。

JOBS_OK = (
    '[{"title":"液压设备维护技师","summary":"负责产线液压回路的日常维护",'
    '"skills":["液压系统日常点检","泵阀故障判读"]},'
    '{"title":"电气控制工程师","skills":["PLC 梯形图编程"]}]'
)


def test_job_requirements_land_in_run_options(client):
    """投的清单要原样落进 options —— ⑧ 站从这里取值写进域注册清单。"""
    c, seen = client
    assert _post(c, {"corpus": "probe", "job_requirements": JOBS_OK}).status_code == 200
    jobs = seen["options"]["job_requirements"]
    assert [j["title"] for j in jobs] == ["液压设备维护技师", "电气控制工程师"]
    assert jobs[0]["skills"] == ["液压系统日常点检", "泵阀故障判读"]
    assert jobs[0]["summary"] == "负责产线液压回路的日常维护"
    # job_id 没给就按序号补：学习端拿它当列表 key，一串空串会让所有岗位共用一个 key
    assert [j["job_id"] for j in jobs] == ["job-1", "job-2"]


def test_job_requirements_absent_leaves_options_alone(client):
    """不填也能建库——空的这一格不写进 options，⑧ 站照旧写 null。"""
    c, seen = client
    assert _post(c, {"corpus": "probe"}).status_code == 200
    assert "job_requirements" not in seen.get("options", {})


@pytest.mark.parametrize(
    "bad",
    [
        "{不是 json",                                    # 根本不是 JSON
        '{"jobs":[]}',                                   # 不是数组
        "[]",                                            # 空数组等于没登记，让他留空
        '["液压技师"]',                                   # 条目不是对象
        '[{"skills":["点检"]}]',                          # 没有岗位名
        '[{"title":"液压技师"}]',                         # 没有 skills
        '[{"title":"液压技师","skills":[]}]',             # skills 空
        '[{"title":"液压技师","skills":"点检"}]',          # skills 不是数组
        '[{"title":"液压技师","skills":["点检",42]}]',     # 混了非字符串——**不许静默跳过**
        '[{"title":"液压技师","skills":["点检","  "]}]',   # 空白技能项同理
    ],
)
def test_job_requirements_bad_shape_is_rejected_not_dropped(client, bad):
    c, seen = client
    resp = _post(c, {"corpus": "probe", "job_requirements": bad})
    assert resp.status_code == 400, bad
    assert resp.json()["detail"], "报错要说人话，不能只有状态码"
    # 坏数据一条都不许进 options，run 也不许建（库名会被占住）
    assert "kind" not in seen


def test_job_requirements_rejected_on_append(client):
    """追加模式整站跳过 ⑧，收下这份清单等于收下之后扔掉——当场拒，不静默丢。"""
    c, _ = client
    resp = _post(c, {"corpus": "probe", "append": "true", "job_requirements": JOBS_OK})
    assert resp.status_code == 400
    assert "追加" in resp.json()["detail"]


def test_job_requirements_duplicate_ids_rejected(client):
    """学习端拿 job_id 当列表 key，重了两个岗位会串成一个。"""
    c, _ = client
    dup = ('[{"job_id":"tech","title":"甲","skills":["a"]},'
           '{"job_id":"tech","title":"乙","skills":["b"]}]')
    resp = _post(c, {"corpus": "probe", "job_requirements": dup})
    assert resp.status_code == 400 and "job_id" in resp.json()["detail"]
