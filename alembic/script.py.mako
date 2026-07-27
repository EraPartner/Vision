"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
Create Date: ${create_date}

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
${imports if imports else ""}

# revision identifiers, used by Alembic.
revision: str = ${repr(up_revision)}
down_revision: Union[str, Sequence[str], None] = ${repr(down_revision)}
branch_labels: Union[str, Sequence[str], None] = ${repr(branch_labels)}
depends_on: Union[str, Sequence[str], None] = ${repr(depends_on)}


def upgrade() -> None:
    """Upgrade schema."""
    # This file is applied by `alembic upgrade head` on the NEXT CONTAINER BOOT of every
    # installation — before, or without, the app code that depends on it. If anything here
    # drops a table/column/view/trigger or retypes a column, CI (verify-destructive-migrations)
    # requires a marker on the line above it saying why that is safe unattended:
    #     # destructive-ok: <reason, citing an ADR / runbook / prior migration>
    # If running code still reads what you are dropping, the change does NOT belong here — put
    # it in alembic/manual/<name>/ instead. See docs/guides/migrations.md and ADR-088.
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    """Downgrade schema."""
    ${downgrades if downgrades else "pass"}
