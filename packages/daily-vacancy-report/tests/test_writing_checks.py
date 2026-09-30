"""Unit tests for writing_checks.py: the model-free checks on letters and CVs."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "common"))

import writing_checks as wc  # noqa: E402

CV = ("Alex Morgan. Cloud Engineer, Contoso Payments (2021 - present): built 40 Terraform modules on Azure for 12 "
      "teams; moved 18 services to Kubernetes. Systems Administrator, Northwind Traders (2018 - 2021).")
GOOD = [
    "The Senior Platform Engineer role at Proseware stood out because it centres on Azure and Terraform, the core of my work.",
    "As Cloud Engineer at Contoso Payments I built 40 Terraform modules on Azure used by 12 teams, and moved 18 "
    "services to Kubernetes without customer downtime.",
    "Before that, as Systems Administrator at Northwind Traders, I looked after Linux servers and automated patching.",
    "I would welcome a conversation about how this experience could support your platform team.",
]


def test_figures_the_cv_does_not_state_are_found():
    assert wc.invented_figures("I cut costs by 35% across 12 teams", CV) == ["35"]
    assert wc.invented_figures("40 modules, 1,200 users", CV) == ["1200"]
    assert wc.honest("built 40 Terraform modules", CV) and not wc.honest("built [number] modules", CV)


def test_job_titles_are_checked_against_the_cv():
    assert wc.invented_titles(GOOD, CV) == []
    assert wc.invented_titles(["As Head of Cloud at Contoso Payments I led the team."], CV) == ["Head of Cloud"]


def test_stock_phrases_are_found_whole_and_case_blind():
    assert wc.cliches("I am EXCITED to apply; I'm a Team Player.") == ["i am excited", "team player"]
    assert wc.cliches("I am passionate\u2019s") == ["passionate"]
    assert wc.cliches("Compassionate care") == []


def test_requirements_are_covered_by_the_whole_term_or_most_key_words():
    text = "I run CI/CD with GitHub Actions and on-call rotas for C# services."
    assert wc.covers("CI/CD", text) and wc.covers("C#", text) and wc.covers("on-call", text)
    assert wc.covers("GitHub Actions pipelines experience", text)
    assert not wc.covers("C", text) and not wc.covers("Kubernetes", text) and not wc.covers("", text)
    assert wc.coverage(["CI/CD", "Kubernetes", "ci/cd "], text) == (["CI/CD"], ["Kubernetes"])


def test_a_good_letter_has_no_problems():
    assert wc.letter_problems(GOOD, CV, requirements=["Azure", "Terraform", "Kubernetes", "Linux"], words=(60, 450)) == []


def test_each_problem_is_an_instruction_a_rewrite_can_follow():
    bad = ["I am excited to apply.", "As Head of Cloud at Contoso Payments I saved [amount] and 35% of costs."]
    problems = wc.letter_problems(bad, CV, requirements=["Azure", "Terraform", "Kubernetes"])
    joined = " | ".join(problems)
    for expected in ("write 3 to 5 paragraphs", "too short", "placeholders [amount]", "not Head of Cloud",
                     "figures the CV does not state: 35", "'i am excited'", "main requirements, such as Azure"):
        assert expected in joined


def test_figures_from_the_advert_are_allowed_when_given_as_the_source():
    letter = GOOD[:3] + ["Your 900 clinics rely on the platform, and I would welcome a conversation."]
    assert "figures" in " ".join(wc.letter_problems(letter, CV, words=(60, 450)))
    assert wc.letter_problems(letter, CV, source="Proseware serves 900 clinics", words=(60, 450)) == []


def test_a_long_letter_is_too_long():
    assert "too long" in " ".join(wc.letter_problems(GOOD * 3, CV, words=(60, 200), paragraph_range=(1, 20)))


def test_the_score_has_what_the_bench_compares():
    score = wc.letter_score(GOOD, CV, requirements=["Azure", "Kubernetes", "Python"])
    assert score["coverage"] == 0.67 and score["missing"] == ["Python"] and score["paragraphs"] == 4
    assert wc.letter_score(GOOD, CV)["coverage"] is None
